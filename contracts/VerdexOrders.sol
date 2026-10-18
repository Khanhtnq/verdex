// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Verdex Orders without you
/// @notice Limit and stop orders on tokenized stocks on Robinhood Chain that fill without the owner.
///         An order names what to pay with, what to receive, a Uniswap v3 pool, an amount and a price
///         level. When the pool's price is at or past the level, an executor calls `execute`: the contract
///         pulls the amount from the owner's allowance, swaps it in the pool, sends the proceeds to the
///         owner and a small USDG tip to the executor. The contract holds nothing between fills. The owner
///         can cancel at any time, and ends every order for good by revoking the allowance.
/// @dev    The price level is the pool's own sqrtPriceX96, compared in the pool's orientation; the site
///         converts a dollar price into it. No admin can touch an order or move a user's tokens. The admin
///         only keeps the executor list, which exists so the spot-price floor on `execute` cannot be gamed
///         by an arbitrary caller.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

contract VerdexOrders {
    enum Status { Open, Filled, Cancelled }

    struct Order {
        address owner;
        address tokenIn; // what the order pays with, pulled from the owner's allowance at fill time
        address tokenOut; // what the owner receives
        uint24 fee; // the Uniswap v3 pool fee tier
        uint160 trigger; // the pool's sqrtPriceX96 at which the order may fill
        bool whenAtOrBelow; // fill when the pool's sqrtPriceX96 is at or below the trigger (else at or above)
        uint16 maxSlippageBps; // how far below the pool's spot price, at fill time, a fill may land
        uint40 expiresAt; // 0 for no expiry
        Status status;
        uint96 amountIn; // in tokenIn units
        uint96 tip; // in USDG, paid to the executor at fill time: pulled with the amount on a USDG buy, taken from the proceeds on a sell into USDG
        uint128 received; // tokenOut delivered to the owner by the fill
        uint40 filledAt;
    }

    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    address public admin;
    mapping(address => bool) public isExecutor;

    uint256 public orderCount;
    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) private _ordersOf;

    address private _activePool; // the pool allowed to call back during a swap
    uint256 private _lock = 1;

    event Placed(uint256 indexed id, address indexed owner, address tokenIn, address tokenOut, uint24 fee, uint96 amountIn, uint160 trigger, bool whenAtOrBelow, uint40 expiresAt);
    event Cancelled(uint256 indexed id);
    event Filled(uint256 indexed id, address indexed executor, uint256 amountIn, uint256 amountOut, uint256 tip);
    event ExecutorSet(address indexed executor, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAdmin();
    error NotExecutor();
    error BadOrder();
    error NoPool();
    error NotOpen();
    error NotTriggered();
    error Expired();
    error Slippage();
    error BadCallback();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address factory_, address usdg_, address executor_) {
        if (factory_ == address(0) || usdg_ == address(0)) revert BadOrder();
        factory = IUniswapV3Factory(factory_);
        usdg = usdg_;
        admin = msg.sender;
        if (executor_ != address(0)) {
            isExecutor[executor_] = true;
            emit ExecutorSet(executor_, true);
        }
    }

    // ---- orders ----

    /// @notice Places an order. One side of it must be USDG (the tip is paid in USDG).
    /// @param trigger the pool's sqrtPriceX96 at which the order may fill
    /// @param whenAtOrBelow true to fill when the pool price is at or below the trigger, false for at or above
    /// @param expiresAt unix time after which the order can no longer fill; 0 for never
    function place(address tokenIn, address tokenOut, uint24 fee, uint96 amountIn, uint96 tip, uint160 trigger, bool whenAtOrBelow, uint16 maxSlippageBps, uint40 expiresAt) external returns (uint256 id) {
        if (amountIn == 0 || tokenIn == tokenOut || trigger == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadOrder();
        if (tokenIn != usdg && tokenOut != usdg) revert BadOrder();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert BadOrder();
        if (factory.getPool(tokenIn, tokenOut, fee) == address(0)) revert NoPool();
        id = ++orderCount;
        orders[id] = Order({
            owner: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            trigger: trigger,
            whenAtOrBelow: whenAtOrBelow,
            maxSlippageBps: maxSlippageBps,
            expiresAt: expiresAt,
            status: Status.Open,
            amountIn: amountIn,
            tip: tip,
            received: 0,
            filledAt: 0
        });
        _ordersOf[msg.sender].push(id);
        emit Placed(id, msg.sender, tokenIn, tokenOut, fee, amountIn, trigger, whenAtOrBelow, expiresAt);
    }

    function cancel(uint256 id) external {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (o.status != Status.Open) revert NotOpen();
        o.status = Status.Cancelled;
        emit Cancelled(id);
    }

    function ordersOf(address owner) external view returns (uint256[] memory) {
        return _ordersOf[owner];
    }

    // ---- views ----

    function _pool(Order storage o) private view returns (IUniswapV3Pool) {
        return IUniswapV3Pool(factory.getPool(o.tokenIn, o.tokenOut, o.fee));
    }

    /// @notice The pool's current sqrtPriceX96 for an order, in the pool's orientation.
    function poolPrice(uint256 id) public view returns (uint160 sqrtP) {
        (sqrtP,,,,,,) = _pool(orders[id]).slot0();
    }

    /// @notice Whether the pool's price is at or past the order's level right now.
    function isTriggered(uint256 id) public view returns (bool) {
        Order storage o = orders[id];
        if (o.owner == address(0)) return false;
        uint160 sqrtP = poolPrice(id);
        return o.whenAtOrBelow ? sqrtP <= o.trigger : sqrtP >= o.trigger;
    }

    /// @notice Whether an order may fill right now, ignoring the owner's balance and allowance.
    function isDue(uint256 id) public view returns (bool) {
        Order storage o = orders[id];
        return o.status == Status.Open && (o.expiresAt == 0 || block.timestamp <= o.expiresAt) && isTriggered(id);
    }

    /// @notice What the order would return at the pool's spot price, before fees and price impact.
    function quoteSpot(uint256 id) public view returns (uint256 amountOut) {
        Order storage o = orders[id];
        IUniswapV3Pool pool = _pool(o);
        (uint160 sqrtP,,,,,,) = pool.slot0();
        bool zeroForOne = pool.token0() == o.tokenIn;
        uint256 amountIn = o.amountIn;
        if (zeroForOne) {
            amountOut = (amountIn * sqrtP) >> 96;
            amountOut = (amountOut * sqrtP) >> 96;
        } else {
            amountOut = (amountIn << 96) / sqrtP;
            amountOut = (amountOut << 96) / sqrtP;
        }
    }

    /// @notice The lowest fill `execute` accepts for an order right now: spot, less the order's slippage.
    function floorOut(uint256 id) public view returns (uint256) {
        return (quoteSpot(id) * (10_000 - orders[id].maxSlippageBps)) / 10_000;
    }

    // ---- execution ----

    /// @notice Fills a triggered order. Callable by an allowed executor or by the order's owner.
    /// @param minOut the least tokenOut the owner must receive (before the tip on a sell); at least `floorOut(id)`
    function execute(uint256 id, uint256 minOut) external nonReentrant returns (uint256 amountOut) {
        Order storage o = orders[id];
        if (o.owner == address(0)) revert BadOrder();
        if (!isExecutor[msg.sender] && msg.sender != o.owner) revert NotExecutor();
        if (o.status != Status.Open) revert NotOpen();
        if (o.expiresAt != 0 && block.timestamp > o.expiresAt) revert Expired();
        if (!isTriggered(id)) revert NotTriggered();
        if (minOut < floorOut(id)) revert Slippage();

        IUniswapV3Pool pool = _pool(o);
        uint256 amountIn = o.amountIn;
        uint256 tip = msg.sender == o.owner ? 0 : o.tip;
        bool buyWithUsdg = o.tokenIn == usdg;

        // One pull for the amount (and the tip, when the order pays in USDG). Reverts if allowance or balance is short.
        require(IERC20(o.tokenIn).transferFrom(o.owner, address(this), buyWithUsdg ? amountIn + tip : amountIn), "pull");

        bool zeroForOne = pool.token0() == o.tokenIn;
        // A buy sends the stock straight to the owner; a sell lands the USDG here so the tip can come out of it.
        address recipient = buyWithUsdg ? o.owner : address(this);
        _activePool = address(pool);
        (int256 a0, int256 a1) = pool.swap(recipient, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(o.tokenIn));
        _activePool = address(0);
        uint256 inAmt = uint256(zeroForOne ? a0 : a1);
        amountOut = uint256(-(zeroForOne ? a1 : a0));
        if (inAmt != amountIn || amountOut < minOut) revert Slippage();

        if (buyWithUsdg) {
            if (tip != 0) require(IERC20(usdg).transfer(msg.sender, tip), "tip");
        } else {
            if (tip > amountOut) tip = amountOut; // never more than the proceeds
            if (tip != 0) require(IERC20(usdg).transfer(msg.sender, tip), "tip");
            amountOut -= tip;
            if (amountOut < minOut) revert Slippage();
            require(IERC20(usdg).transfer(o.owner, amountOut), "out");
        }

        o.status = Status.Filled;
        o.received = uint128(amountOut);
        o.filledAt = uint40(block.timestamp);
        emit Filled(id, msg.sender, amountIn, amountOut, tip);
    }

    /// @dev Uniswap v3 asks for the input token here, mid-swap. Only the pool being swapped may call.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _activePool || _activePool == address(0)) revert BadCallback();
        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        require(IERC20(tokenIn).transfer(msg.sender, owed), "pay");
    }

    // ---- admin: the executor list only ----

    function setExecutor(address executor, bool allowed) external {
        if (msg.sender != admin) revert NotAdmin();
        isExecutor[executor] = allowed;
        emit ExecutorSet(executor, allowed);
    }

    function transferAdmin(address to) external {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert BadOrder();
        emit AdminTransferred(admin, to);
        admin = to;
    }
}

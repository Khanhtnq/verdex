// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Verdex Auto-Invest, on Base
/// @notice Recurring buys of tokenized stocks on Base that run without the owner, from Aerodrome Slipstream pools
///         (the same maths as Uniswap v3; pools found by tick spacing, callback with the Uniswap v3 name). The
///         Robinhood Chain contract with the pool interface swapped.
///         A plan names what to pay with, what to buy, how much, how often and for how long. When a buy is
///         due, an executor calls `execute`: the contract pulls one buy's worth from the owner's allowance,
///         swaps it in the Uniswap v3 pool the plan names, sends the stock to the owner and a small tip to
///         the executor. The contract holds nothing between buys. The owner can pause, resume, cancel or
///         execute their own plan at any time, and ends it for good by revoking the allowance.
/// @dev    No admin can touch a plan or move a user's tokens. The admin only keeps the executor list, which
///         exists so that the spot-price floor on `execute` cannot be gamed by an arbitrary caller.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ICLFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

contract VerdexAutoInvestCL {
    struct Plan {
        address owner;
        address tokenIn; // what the plan pays with, pulled from the owner's allowance
        address tokenOut; // what it buys, sent straight to the owner
        int24 tickSpacing; // the Uniswap v3 pool fee tier the plan trades in
        uint32 interval; // seconds between buys
        uint40 nextAt; // when the next buy may run
        uint32 buysLeft; // UNLIMITED for an open-ended plan
        uint32 buysDone;
        uint16 maxSlippageBps; // how far below the pool's spot price a fill may land
        bool paused;
        uint96 amountIn; // per buy, in tokenIn units
        uint96 tip; // per buy, in tokenIn units, paid to the executor
        uint128 spent; // tokenIn swapped so far, tips excluded
        uint128 received; // tokenOut delivered so far
    }

    uint32 public constant UNLIMITED = type(uint32).max;
    uint32 public constant MIN_INTERVAL = 1 hours;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    ICLFactory public immutable factory;
    address public admin;
    mapping(address => bool) public isExecutor;

    uint256 public planCount;
    mapping(uint256 => Plan) public plans;
    mapping(address => uint256[]) private _plansOf;

    address private _activePool; // the pool allowed to call back during a swap
    uint256 private _lock = 1;

    event PlanCreated(uint256 indexed id, address indexed owner, address tokenIn, address tokenOut, int24 tickSpacing, uint96 amountIn, uint32 interval, uint40 firstAt, uint32 buys);
    event PlanPaused(uint256 indexed id, bool paused);
    event PlanCancelled(uint256 indexed id);
    event Executed(uint256 indexed id, address indexed executor, uint256 amountIn, uint256 amountOut, uint256 tip, uint40 nextAt);
    event ExecutorSet(address indexed executor, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAdmin();
    error NotExecutor();
    error BadPlan();
    error NoPool();
    error NotDue();
    error Paused();
    error Finished();
    error Slippage();
    error BadCallback();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address factory_, address executor_) {
        factory = ICLFactory(factory_);
        admin = msg.sender;
        if (executor_ != address(0)) {
            isExecutor[executor_] = true;
            emit ExecutorSet(executor_, true);
        }
    }

    // ---- plans ----

    /// @param firstAt when the first buy may run; 0 means now
    /// @param buys number of buys, or UNLIMITED
    function createPlan(address tokenIn, address tokenOut, int24 tickSpacing, uint96 amountIn, uint96 tip, uint32 interval, uint40 firstAt, uint32 buys, uint16 maxSlippageBps) external returns (uint256 id) {
        if (amountIn == 0 || buys == 0 || tokenIn == tokenOut || interval < MIN_INTERVAL || maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadPlan();
        if (factory.getPool(tokenIn, tokenOut, tickSpacing) == address(0)) revert NoPool();
        id = ++planCount;
        plans[id] = Plan({
            owner: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            tickSpacing: tickSpacing,
            interval: interval,
            nextAt: firstAt == 0 ? uint40(block.timestamp) : firstAt,
            buysLeft: buys,
            buysDone: 0,
            maxSlippageBps: maxSlippageBps,
            paused: false,
            amountIn: amountIn,
            tip: tip,
            spent: 0,
            received: 0
        });
        _plansOf[msg.sender].push(id);
        emit PlanCreated(id, msg.sender, tokenIn, tokenOut, tickSpacing, amountIn, interval, plans[id].nextAt, buys);
    }

    function setPaused(uint256 id, bool paused) external {
        Plan storage p = plans[id];
        if (p.owner != msg.sender) revert NotOwner();
        p.paused = paused;
        emit PlanPaused(id, paused);
    }

    function cancel(uint256 id) external {
        Plan storage p = plans[id];
        if (p.owner != msg.sender) revert NotOwner();
        p.buysLeft = 0;
        p.paused = true;
        emit PlanCancelled(id);
    }

    function plansOf(address owner) external view returns (uint256[] memory) {
        return _plansOf[owner];
    }

    /// @notice Whether a plan may run right now, ignoring the owner's balance and allowance.
    function isDue(uint256 id) public view returns (bool) {
        Plan storage p = plans[id];
        return p.owner != address(0) && !p.paused && p.buysLeft != 0 && block.timestamp >= p.nextAt;
    }

    /// @notice What one buy would return at the pool's spot price, before fees and price impact.
    function quoteSpot(uint256 id) public view returns (uint256 amountOut) {
        Plan storage p = plans[id];
        IUniswapV3Pool pool = IUniswapV3Pool(factory.getPool(p.tokenIn, p.tokenOut, p.tickSpacing));
        (uint160 sqrtP,,,,,,) = pool.slot0();
        bool zeroForOne = pool.token0() == p.tokenIn;
        uint256 amountIn = p.amountIn;
        if (zeroForOne) {
            // out = in * sqrtP^2 / 2^192, in two steps so nothing overflows
            amountOut = (amountIn * sqrtP) >> 96;
            amountOut = (amountOut * sqrtP) >> 96;
        } else {
            amountOut = (amountIn << 96) / sqrtP;
            amountOut = (amountOut << 96) / sqrtP;
        }
    }

    /// @notice The lowest fill `execute` accepts for a plan right now: spot, less the plan's slippage.
    function floorOut(uint256 id) public view returns (uint256) {
        return (quoteSpot(id) * (10_000 - plans[id].maxSlippageBps)) / 10_000;
    }

    // ---- execution ----

    /// @notice Runs one buy of a due plan. Callable by an allowed executor or by the plan's owner.
    /// @param minOut the least tokenOut the owner must receive; must be at least `floorOut(id)`
    function execute(uint256 id, uint256 minOut) external nonReentrant returns (uint256 amountOut) {
        Plan storage p = plans[id];
        if (p.owner == address(0)) revert BadPlan();
        if (!isExecutor[msg.sender] && msg.sender != p.owner) revert NotExecutor();
        if (p.paused) revert Paused();
        if (p.buysLeft == 0) revert Finished();
        if (block.timestamp < p.nextAt) revert NotDue();
        if (minOut < floorOut(id)) revert Slippage();

        IUniswapV3Pool pool = IUniswapV3Pool(factory.getPool(p.tokenIn, p.tokenOut, p.tickSpacing));
        uint256 amountIn = p.amountIn;
        uint256 tip = msg.sender == p.owner ? 0 : p.tip;

        // One pull for the buy and the tip. Reverts if the allowance or balance is short.
        require(IERC20(p.tokenIn).transferFrom(p.owner, address(this), amountIn + tip), "pull");

        bool zeroForOne = pool.token0() == p.tokenIn;
        _activePool = address(pool);
        (int256 a0, int256 a1) = pool.swap(p.owner, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(p.tokenIn));
        _activePool = address(0);
        uint256 inAmt = uint256(zeroForOne ? a0 : a1);
        amountOut = uint256(-(zeroForOne ? a1 : a0));
        if (inAmt != amountIn || amountOut < minOut) revert Slippage();

        if (tip != 0) require(IERC20(p.tokenIn).transfer(msg.sender, tip), "tip");

        if (p.buysLeft != UNLIMITED) p.buysLeft -= 1;
        p.buysDone += 1;
        p.spent += uint128(amountIn);
        p.received += uint128(amountOut);
        // The next run is one interval after this one, never in the past, so a missed buy does not pile up.
        uint40 next = p.nextAt + p.interval;
        if (next <= block.timestamp) next = uint40(block.timestamp) + p.interval;
        p.nextAt = next;
        emit Executed(id, msg.sender, amountIn, amountOut, tip, next);
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
        emit AdminTransferred(admin, to);
        admin = to;
    }
}

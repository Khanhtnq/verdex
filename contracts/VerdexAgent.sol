// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Verdex Agent without you
/// @notice A budget and rules for an agent, kept by a contract on Robinhood Chain. A mandate names the tokenized
///         stocks the agent may trade, the rule it follows, how much USDG it may spend in all, per trade and per
///         day, the least time between two trades on the same stock, a price floor, an expiry and a tip. Inside
///         those limits an allowed executor (the agent's hands) calls `execute`: the contract pulls the amount from
///         the owner's allowance, swaps it in the stock's Uniswap v3 pool against USDG, sends the proceeds to the
///         owner and a small USDG tip to the executor. It holds nothing between trades. The owner can pause, top
///         up or close a mandate at any time, and ends everything for good by revoking the allowances.
/// @dev    The rule and its parameter are stored for the executor and the site to read; the contract enforces the
///         limits, not the timing. The worst an executor can do is trade inside the limits, at the pool's spot
///         price less the slippage, read in the same transaction. No admin can touch a mandate or move a user's
///         tokens; the admin only keeps the executor list.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
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

contract VerdexAgent {
    struct Mandate {
        address owner;
        uint8 rule; // what the agent does with it (0 buys dips, 1 buys strength, 2 takes profits, 3 cuts losses); read by the executor, not enforced here
        uint16 param; // the rule's size in bps of a day's move, e.g. 300 for 3%
        uint16 maxSlippageBps; // floor on every trade, below the pool's spot price
        uint32 cooldown; // least seconds between two trades on the same stock
        bool paused;
        bool closed;
        uint40 expiresAt; // 0 for never
        uint96 budget; // USDG the agent may still spend on buys
        uint96 perTrade; // USDG cap on one trade: a buy's amount, a sale's value at spot
        uint96 perDay; // USDG cap on the trades of one day, buys and sales together
        uint96 tip; // USDG per trade, to the executor: pulled with a buy, taken from a sale's proceeds
        uint40 dayStart;
        uint96 spentToday;
        uint96 spent; // USDG spent on buys, in all
        uint40 lastTrade;
        uint96 sold; // USDG sent to the owner from sales, in all
        uint32 trades;
    }

    uint16 private constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint16 public constant MAX_PARAM_BPS = 5_000;
    uint32 public constant MIN_COOLDOWN = 1 hours;
    uint256 public constant MAX_TOKENS = 12;
    uint256 public constant MIN_TRADE_USDG = 1e6; // trades under one USDG are refused
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    address public admin;
    mapping(address => bool) public isExecutor;

    uint256 public mandateCount;
    mapping(uint256 => Mandate) public mandates;
    mapping(uint256 => address[]) private _tokens;
    mapping(uint256 => uint24[]) private _fees;
    mapping(uint256 => mapping(address => uint40)) public lastTradeAt;
    mapping(address => uint256[]) private _mandatesOf;

    address private _activePool;
    uint256 private _lock = 1;

    event MandateCreated(uint256 indexed id, address indexed owner, address[] tokens, uint8 rule, uint16 param, uint96 budget, uint96 perTrade, uint96 perDay);
    event MandatePaused(uint256 indexed id, bool paused);
    event MandateClosed(uint256 indexed id);
    event ToppedUp(uint256 indexed id, uint96 amount, uint96 budget);
    event Traded(uint256 indexed id, address indexed executor, address indexed token, bool sell, uint256 amountIn, uint256 amountOut, uint256 tip);
    event ExecutorSet(address indexed executor, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAdmin();
    error NotExecutor();
    error BadMandate();
    error NoPool();
    error NotAllowed(uint8 code);
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
        if (factory_ == address(0) || usdg_ == address(0)) revert BadMandate();
        factory = IUniswapV3Factory(factory_);
        usdg = usdg_;
        admin = msg.sender;
        if (executor_ != address(0)) {
            isExecutor[executor_] = true;
            emit ExecutorSet(executor_, true);
        }
    }

    // ---- mandates ----

    /// @notice Creates a mandate. Every token needs a USDG pool at the fee given; the caps are in USDG units.
    function create(address[] calldata tokens, uint24[] calldata fees, uint8 rule, uint16 param, uint96 budget, uint96 perTrade, uint96 perDay, uint16 maxSlippageBps, uint32 cooldown, uint40 expiresAt, uint96 tip) external returns (uint256 id) {
        uint256 n = tokens.length;
        if (n == 0 || n > MAX_TOKENS || fees.length != n) revert BadMandate();
        if (param > MAX_PARAM_BPS || perTrade < MIN_TRADE_USDG || perDay < perTrade || maxSlippageBps > MAX_SLIPPAGE_BPS || cooldown < MIN_COOLDOWN) revert BadMandate();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert BadMandate();
        for (uint256 i = 0; i < n; i++) {
            if (tokens[i] == usdg) revert BadMandate();
            for (uint256 j = 0; j < i; j++) if (tokens[j] == tokens[i]) revert BadMandate();
            if (factory.getPool(tokens[i], usdg, fees[i]) == address(0)) revert NoPool();
        }
        id = ++mandateCount;
        Mandate storage m = mandates[id];
        m.owner = msg.sender;
        m.rule = rule;
        m.param = param;
        m.maxSlippageBps = maxSlippageBps;
        m.cooldown = cooldown;
        m.expiresAt = expiresAt;
        m.budget = budget;
        m.perTrade = perTrade;
        m.perDay = perDay;
        m.tip = tip;
        m.dayStart = uint40(block.timestamp);
        for (uint256 i = 0; i < n; i++) {
            _tokens[id].push(tokens[i]);
            _fees[id].push(fees[i]);
        }
        _mandatesOf[msg.sender].push(id);
        emit MandateCreated(id, msg.sender, tokens, rule, param, budget, perTrade, perDay);
    }

    function topUp(uint256 id, uint96 amount) external {
        Mandate storage m = mandates[id];
        if (m.owner != msg.sender) revert NotOwner();
        if (m.closed) revert BadMandate();
        m.budget += amount;
        emit ToppedUp(id, amount, m.budget);
    }

    function setPaused(uint256 id, bool paused) external {
        Mandate storage m = mandates[id];
        if (m.owner != msg.sender) revert NotOwner();
        if (m.closed) revert BadMandate();
        m.paused = paused;
        emit MandatePaused(id, paused);
    }

    /// @notice Closes a mandate for good. Revoking the allowances does the same from the token side.
    function close(uint256 id) external {
        Mandate storage m = mandates[id];
        if (m.owner != msg.sender) revert NotOwner();
        m.closed = true;
        emit MandateClosed(id);
    }

    function mandatesOf(address owner) external view returns (uint256[] memory) {
        return _mandatesOf[owner];
    }

    function tokensOf(uint256 id) external view returns (address[] memory tokens, uint24[] memory fees) {
        return (_tokens[id], _fees[id]);
    }

    // ---- views ----

    function _pool(address token, uint24 fee) private view returns (IUniswapV3Pool) {
        return IUniswapV3Pool(factory.getPool(token, usdg, fee));
    }

    /// @dev What `amountIn` of `tokenIn` returns at the pool's spot price, before fees and price impact.
    function _spot(IUniswapV3Pool pool, address tokenIn, uint256 amountIn) private view returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        (uint160 sqrtP,,,,,,) = pool.slot0();
        if (pool.token0() == tokenIn) {
            amountOut = (amountIn * sqrtP) >> 96;
            amountOut = (amountOut * sqrtP) >> 96;
        } else {
            amountOut = (amountIn << 96) / sqrtP;
            amountOut = (amountOut << 96) / sqrtP;
        }
    }

    /// @notice What a trade would return at the pool's spot price. A buy pays `amountIn` USDG for stock `i`; a sale
    ///         sells `amountIn` units of stock `i` for USDG.
    function quoteSpot(uint256 id, uint256 i, bool sell, uint256 amountIn) public view returns (uint256) {
        if (i >= _tokens[id].length) return 0;
        address token = _tokens[id][i];
        return _spot(_pool(token, _fees[id][i]), sell ? token : usdg, amountIn);
    }

    /// @notice The lowest fill `execute` accepts for the trade right now: spot, less the mandate's slippage.
    function floorOut(uint256 id, uint256 i, bool sell, uint256 amountIn) public view returns (uint256) {
        return (quoteSpot(id, i, sell, amountIn) * (BPS - mandates[id].maxSlippageBps)) / BPS;
    }

    /// @notice USDG the mandate may still trade today, under its day cap.
    function leftToday(uint256 id) public view returns (uint256) {
        Mandate storage m = mandates[id];
        uint256 today = block.timestamp >= uint256(m.dayStart) + 1 days ? 0 : m.spentToday;
        return today >= m.perDay ? 0 : m.perDay - today;
    }

    /// @notice Whether the trade fits the mandate right now, ignoring the owner's balance and allowance.
    ///         0 fits; 1 no such mandate or closed; 2 paused; 3 expired; 4 no such stock; 5 cooling down;
    ///         6 under one USDG; 7 over the per-trade cap; 8 over the day cap; 9 over the budget.
    function check(uint256 id, uint256 i, bool sell, uint256 amountIn) public view returns (uint8) {
        Mandate storage m = mandates[id];
        if (m.owner == address(0) || m.closed) return 1;
        if (m.paused) return 2;
        if (m.expiresAt != 0 && block.timestamp > m.expiresAt) return 3;
        if (i >= _tokens[id].length) return 4;
        address token = _tokens[id][i];
        if (block.timestamp < uint256(lastTradeAt[id][token]) + m.cooldown) return 5;
        uint256 value = sell ? quoteSpot(id, i, true, amountIn) : amountIn;
        if (value < MIN_TRADE_USDG) return 6;
        if (value > m.perTrade) return 7;
        if (value > leftToday(id)) return 8;
        if (!sell && value > m.budget) return 9;
        return 0;
    }

    // ---- execution ----

    /// @notice Trades inside a mandate. Callable by an allowed executor or by the mandate's owner.
    /// @param i the stock's index in the mandate
    /// @param sell false to buy stock `i` with `amountIn` USDG, true to sell `amountIn` units of it for USDG
    /// @param minOut the least the owner must receive (before the tip on a sale); at least `floorOut`
    function execute(uint256 id, uint256 i, bool sell, uint256 amountIn, uint256 minOut) external nonReentrant returns (uint256 amountOut) {
        Mandate storage m = mandates[id];
        if (m.owner == address(0)) revert BadMandate();
        if (!isExecutor[msg.sender] && msg.sender != m.owner) revert NotExecutor();
        uint8 code = check(id, i, sell, amountIn);
        if (code != 0) revert NotAllowed(code);
        if (minOut < floorOut(id, i, sell, amountIn)) revert Slippage();

        address token = _tokens[id][i];
        IUniswapV3Pool pool = _pool(token, _fees[id][i]);
        uint256 tip = msg.sender == m.owner ? 0 : m.tip;
        uint256 value = sell ? quoteSpot(id, i, true, amountIn) : amountIn;

        if (block.timestamp >= uint256(m.dayStart) + 1 days) {
            m.dayStart = uint40(block.timestamp);
            m.spentToday = 0;
        }
        m.spentToday += uint96(value);
        lastTradeAt[id][token] = uint40(block.timestamp);
        m.lastTrade = uint40(block.timestamp);
        m.trades += 1;

        if (!sell) {
            // One pull for the amount and the tip; the stock goes straight to the owner.
            require(IERC20(usdg).transferFrom(m.owner, address(this), amountIn + tip), "pull");
            amountOut = _swap(pool, usdg, amountIn, m.owner, minOut);
            if (tip != 0) require(IERC20(usdg).transfer(msg.sender, tip), "tip");
            m.budget -= uint96(amountIn);
            m.spent += uint96(amountIn);
        } else {
            // The USDG lands here so the tip can come out of it; the rest goes to the owner.
            require(IERC20(token).transferFrom(m.owner, address(this), amountIn), "pull");
            amountOut = _swap(pool, token, amountIn, address(this), minOut);
            if (tip > amountOut) tip = amountOut;
            if (tip != 0) require(IERC20(usdg).transfer(msg.sender, tip), "tip");
            amountOut -= tip;
            if (amountOut < minOut) revert Slippage();
            require(IERC20(usdg).transfer(m.owner, amountOut), "out");
            m.sold += uint96(amountOut);
        }
        emit Traded(id, msg.sender, token, sell, amountIn, amountOut, tip);
    }

    function _swap(IUniswapV3Pool pool, address tokenIn, uint256 amountIn, address recipient, uint256 minOut) private returns (uint256 amountOut) {
        bool zeroForOne = pool.token0() == tokenIn;
        _activePool = address(pool);
        (int256 a0, int256 a1) = pool.swap(recipient, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(tokenIn));
        _activePool = address(0);
        uint256 inAmt = uint256(zeroForOne ? a0 : a1);
        amountOut = uint256(-(zeroForOne ? a1 : a0));
        if (inAmt != amountIn || amountOut < minOut) revert Slippage();
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
        if (to == address(0)) revert BadMandate();
        emit AdminTransferred(admin, to);
        admin = to;
    }
}

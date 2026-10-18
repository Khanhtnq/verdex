// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Verdex Vaults without you
/// @notice Target weights over tokenized stocks on Robinhood Chain, kept by a contract while the owner is away.
///         A vault names the stocks, their target weights, a drift threshold and how often it may run. When
///         the weights (valued at the stocks' pool prices) have drifted past the threshold and the interval
///         has passed, an executor calls `execute`: inside one transaction the contract pulls the overweight
///         stocks from the owner's allowances, sells them for USDG in their Uniswap v3 pools, takes a small
///         USDG tip, buys the underweight stocks with the proceeds and sends everything to the owner. It holds
///         nothing between runs. The owner can pause, resume or run the vault at any time, and ends it for
///         good by revoking the allowances.
/// @dev    Every leg has a floor: the pool's spot price less the vault's slippage, read in the same
///         transaction. No admin can touch a vault or move a user's tokens; the admin only keeps the executor
///         list, so the floors cannot be gamed by an arbitrary caller.
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

contract VerdexVaults {
    struct Leg {
        address token; // a stock
        uint24 fee; // its USDG pool's fee tier
        uint16 targetBps; // target weight, the legs sum to 10_000
    }
    struct Vault {
        address owner;
        uint16 thresholdBps; // run when any leg is this far from its target
        uint16 maxSlippageBps; // floor on every leg, below the pool's spot price
        uint32 interval; // seconds between runs
        uint40 lastRun;
        uint32 runs;
        bool paused;
        uint96 tip; // USDG per run, taken from the sale proceeds
    }

    uint16 private constant BPS = 10_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint32 public constant MIN_INTERVAL = 1 hours;
    uint256 public constant MIN_LEG_USDG = 1e6; // legs under one USDG are skipped
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    address public admin;
    mapping(address => bool) public isExecutor;

    uint256 public vaultCount;
    mapping(uint256 => Vault) public vaults;
    mapping(uint256 => Leg[]) private _legs;
    mapping(address => uint256[]) private _vaultsOf;

    address private _activePool;
    uint256 private _lock = 1;

    event VaultCreated(uint256 indexed id, address indexed owner, address[] tokens, uint16[] targets, uint16 thresholdBps, uint32 interval);
    event VaultPaused(uint256 indexed id, bool paused);
    event Rebalanced(uint256 indexed id, address indexed executor, uint256 totalUsdg, uint256 soldUsdg, uint256 boughtUsdg, uint256 tip);
    event ExecutorSet(address indexed executor, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotAdmin();
    error NotExecutor();
    error BadVault();
    error NoPool();
    error NotDue();
    error Paused();
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
        if (factory_ == address(0) || usdg_ == address(0)) revert BadVault();
        factory = IUniswapV3Factory(factory_);
        usdg = usdg_;
        admin = msg.sender;
        if (executor_ != address(0)) {
            isExecutor[executor_] = true;
            emit ExecutorSet(executor_, true);
        }
    }

    // ---- vaults ----

    /// @notice Creates a vault. Targets sum to 10_000; every token needs a USDG pool at the fee given.
    function create(address[] calldata tokens, uint24[] calldata fees, uint16[] calldata targets, uint16 thresholdBps, uint32 interval, uint16 maxSlippageBps, uint96 tip) external returns (uint256 id) {
        uint256 n = tokens.length;
        if (n < 2 || n > 12 || fees.length != n || targets.length != n) revert BadVault();
        if (thresholdBps == 0 || thresholdBps > 5_000 || interval < MIN_INTERVAL || maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadVault();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            if (tokens[i] == usdg || targets[i] == 0) revert BadVault();
            for (uint256 j = 0; j < i; j++) if (tokens[j] == tokens[i]) revert BadVault();
            if (factory.getPool(tokens[i], usdg, fees[i]) == address(0)) revert NoPool();
            sum += targets[i];
        }
        if (sum != BPS) revert BadVault();
        id = ++vaultCount;
        vaults[id] = Vault({ owner: msg.sender, thresholdBps: thresholdBps, maxSlippageBps: maxSlippageBps, interval: interval, lastRun: 0, runs: 0, paused: false, tip: tip });
        for (uint256 i = 0; i < n; i++) _legs[id].push(Leg({ token: tokens[i], fee: fees[i], targetBps: targets[i] }));
        _vaultsOf[msg.sender].push(id);
        emit VaultCreated(id, msg.sender, tokens, targets, thresholdBps, interval);
    }

    function setPaused(uint256 id, bool paused) external {
        Vault storage v = vaults[id];
        if (v.owner != msg.sender) revert NotOwner();
        v.paused = paused;
        emit VaultPaused(id, paused);
    }

    function vaultsOf(address owner) external view returns (uint256[] memory) {
        return _vaultsOf[owner];
    }

    function legs(uint256 id) external view returns (Leg[] memory) {
        return _legs[id];
    }

    // ---- valuation ----

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

    /// @notice The owner's holdings of each leg, their USDG value at spot, and the total.
    function value(uint256 id) public view returns (uint256[] memory balances, uint256[] memory values, uint256 total) {
        Vault storage v = vaults[id];
        Leg[] storage L = _legs[id];
        balances = new uint256[](L.length);
        values = new uint256[](L.length);
        for (uint256 i = 0; i < L.length; i++) {
            balances[i] = IERC20(L[i].token).balanceOf(v.owner);
            values[i] = _spot(_pool(L[i].token, L[i].fee), L[i].token, balances[i]);
            total += values[i];
        }
    }

    /// @notice The largest distance of any leg from its target, in bps of the vault's value.
    function drift(uint256 id) public view returns (uint16 worst) {
        (, uint256[] memory values, uint256 total) = value(id);
        if (total == 0) return 0;
        Leg[] storage L = _legs[id];
        for (uint256 i = 0; i < L.length; i++) {
            uint256 w = (values[i] * BPS) / total;
            uint256 d = w > L[i].targetBps ? w - L[i].targetBps : L[i].targetBps - w;
            if (d > worst) worst = uint16(d);
        }
    }

    /// @notice Whether the vault may run right now, ignoring the owner's allowances.
    function isDue(uint256 id) public view returns (bool) {
        Vault storage v = vaults[id];
        if (v.owner == address(0) || v.paused) return false;
        if (block.timestamp < uint256(v.lastRun) + v.interval) return false;
        return drift(id) >= v.thresholdBps;
    }

    // ---- execution ----

    /// @notice Rebalances a due vault: sells the overweight legs for USDG, takes the tip, buys the underweight
    ///         legs with the proceeds, sends what is left to the owner. Callable by an allowed executor or the owner.
    function execute(uint256 id) external nonReentrant returns (uint256 soldUsdg, uint256 boughtUsdg) {
        Vault storage v = vaults[id];
        if (v.owner == address(0)) revert BadVault();
        if (!isExecutor[msg.sender] && msg.sender != v.owner) revert NotExecutor();
        if (v.paused) revert Paused();
        if (block.timestamp < uint256(v.lastRun) + v.interval) revert NotDue();
        (uint256[] memory balances, uint256[] memory values, uint256 total) = value(id);
        if (total == 0 || drift(id) < v.thresholdBps) revert NotDue();
        Leg[] storage L = _legs[id];
        uint256 n = L.length;

        // 1. Sell every overweight leg down to its target, each with its floor.
        for (uint256 i = 0; i < n; i++) {
            uint256 target = (total * L[i].targetBps) / BPS;
            if (values[i] <= target + MIN_LEG_USDG) continue;
            uint256 units = (balances[i] * (values[i] - target)) / values[i];
            if (units == 0) continue;
            IUniswapV3Pool pool = _pool(L[i].token, L[i].fee);
            uint256 floor_ = (_spot(pool, L[i].token, units) * (BPS - v.maxSlippageBps)) / BPS;
            require(IERC20(L[i].token).transferFrom(v.owner, address(this), units), "pull");
            soldUsdg += _swap(pool, L[i].token, units, address(this), floor_);
        }

        // 2. The tip, out of the proceeds (waived when the owner rebalances their own vault).
        uint256 tip = msg.sender == v.owner ? 0 : v.tip;
        if (tip > soldUsdg) tip = soldUsdg;
        if (tip != 0) require(IERC20(usdg).transfer(msg.sender, tip), "tip");
        uint256 cash = soldUsdg - tip;

        // 3. Buy every underweight leg up to its target with what the sales produced, pro rata if short.
        uint256 need;
        for (uint256 i = 0; i < n; i++) {
            uint256 target = (total * L[i].targetBps) / BPS;
            if (target > values[i] + MIN_LEG_USDG) need += target - values[i];
        }
        for (uint256 i = 0; i < n && cash != 0 && need != 0; i++) {
            uint256 target = (total * L[i].targetBps) / BPS;
            if (target <= values[i] + MIN_LEG_USDG) continue;
            uint256 want = target - values[i];
            // Pro rata over what is still needed, so a shortfall is shared and the last leg is not starved.
            uint256 spend = need <= cash ? want : (want * cash) / need;
            need -= want;
            if (spend > cash) spend = cash;
            if (spend < MIN_LEG_USDG) continue;
            IUniswapV3Pool pool = _pool(L[i].token, L[i].fee);
            uint256 floor_ = (_spot(pool, usdg, spend) * (BPS - v.maxSlippageBps)) / BPS;
            _swap(pool, usdg, spend, v.owner, floor_);
            cash -= spend;
            boughtUsdg += spend;
        }

        // 4. Whatever USDG is left goes back to the owner; the contract keeps nothing.
        if (cash != 0) require(IERC20(usdg).transfer(v.owner, cash), "rest");

        v.lastRun = uint40(block.timestamp);
        v.runs += 1;
        emit Rebalanced(id, msg.sender, total, soldUsdg, boughtUsdg, tip);
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
        if (to == address(0)) revert BadVault();
        emit AdminTransferred(admin, to);
        admin = to;
    }
}

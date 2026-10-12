// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  VerdexIndexPlans
/// @notice Auto-Invest into any Verdex index (a Verdex one or a community one): a recurring buy that runs while the
///         owner's wallet is closed. On schedule, an executor names how many shares to buy; the contract pulls one
///         buy's USDG from the owner's exact allowance, buys the shares through the Verdex index router with a cap
///         on every leg (the pool's spot price plus the plan's slippage, read in the same transaction), sends the
///         shares straight to the owner, returns the unspent USDG and pays the executor's tip. It holds nothing
///         between buys. The pools of each leg are fixed when the plan is made.
/// @dev    No admin can touch a plan or move a user's tokens; the admin only keeps the executor list. Unaudited.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
interface IIndexRouter {
    function spotIn(address index, uint256 shares, uint24[] calldata fees) external view returns (uint256 total, uint256[] memory perLeg);
    function buy(address index, uint256 shares, uint256 maxIn, uint24[] calldata fees, uint256[] calldata maxInPerLeg, address to) external returns (uint256 spent);
}
interface IIndex {
    function components() external view returns (address[] memory tokens, uint256[] memory units);
}

contract VerdexIndexPlans {
    struct Plan {
        address owner;
        address index;
        uint96 amount; // USDG per buy, the most a buy may spend including the router's fee
        uint96 tip; // USDG to the executor per buy
        uint32 interval;
        uint40 nextAt;
        uint32 buysLeft; // type(uint32).max: until cancelled
        uint32 buysDone;
        uint16 maxSlippageBps;
        bool paused;
        bool cancelled;
        uint128 spent;
        uint128 shares;
    }

    IIndexRouter public immutable router;
    IERC20 public immutable usdg;
    address public admin;
    mapping(address => bool) public isExecutor;
    Plan[] internal _plans;
    mapping(uint256 => uint24[]) internal _fees;
    mapping(address => uint256[]) internal _byOwner;
    uint256 private _lock = 1;

    uint32 public constant MIN_INTERVAL = 1 hours;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint96 public constant MIN_AMOUNT = 1e6; // one USDG

    event PlanCreated(uint256 indexed id, address indexed owner, address indexed index, uint96 amount, uint32 interval, uint32 buys);
    event Bought(uint256 indexed id, address indexed executor, uint256 shares, uint256 spent, uint256 tip, uint40 nextAt);
    event Paused(uint256 indexed id, bool paused);
    event Cancelled(uint256 indexed id);
    event ExecutorSet(address indexed executor, bool allowed);
    event AdminTransferred(address indexed from, address indexed to);

    error BadPlan();
    error NotOwner();
    error NotAdmin();
    error NotExecutor();
    error NotDue();
    error TooDear();
    error TransferFailed();
    error Locked();

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IIndexRouter router_, IERC20 usdg_, address executor_) {
        router = router_;
        usdg = usdg_;
        admin = msg.sender;
        if (executor_ != address(0)) { isExecutor[executor_] = true; emit ExecutorSet(executor_, true); }
    }

    /// @notice A recurring buy of `index`: `amount` USDG every `interval` seconds from `firstAt`, `buys` times.
    /// @param fees the router's pool for each component, in the index's component order (fixed for the plan's life)
    function create(address index, uint24[] calldata fees, uint96 amount, uint96 tip, uint32 interval, uint40 firstAt, uint32 buys, uint16 maxSlippageBps) external returns (uint256 id) {
        (address[] memory tokens,) = IIndex(index).components();
        if (tokens.length == 0 || fees.length != tokens.length || amount < MIN_AMOUNT || interval < MIN_INTERVAL || buys == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS || tip > amount) revert BadPlan();
        router.spotIn(index, 1e18, fees); // the pools exist
        id = _plans.length;
        _plans.push(Plan({ owner: msg.sender, index: index, amount: amount, tip: tip, interval: interval, nextAt: firstAt < block.timestamp ? uint40(block.timestamp) : firstAt, buysLeft: buys, buysDone: 0, maxSlippageBps: maxSlippageBps, paused: false, cancelled: false, spent: 0, shares: 0 }));
        _fees[id] = fees;
        _byOwner[msg.sender].push(id);
        emit PlanCreated(id, msg.sender, index, amount, interval, buys);
    }

    function isDue(uint256 id) public view returns (bool) {
        Plan storage p = _plans[id];
        return !p.paused && !p.cancelled && p.buysLeft > 0 && block.timestamp >= p.nextAt;
    }

    /// @notice USDG `shares` would cost at most, legs capped at spot plus slippage, before the router's fee.
    function capFor(uint256 id, uint256 shares) public view returns (uint256 total, uint256[] memory perLeg) {
        Plan storage p = _plans[id];
        (, uint256[] memory spot) = router.spotIn(p.index, shares, _fees[id]);
        perLeg = new uint256[](spot.length);
        for (uint256 i = 0; i < spot.length; i++) { perLeg[i] = (spot[i] * (10_000 + p.maxSlippageBps)) / 10_000 + 1; total += perLeg[i]; }
    }

    /// @notice Buy `shares` of the plan's index for its owner. Executors and the owner may call it when it is due.
    function execute(uint256 id, uint256 shares) external nonReentrant returns (uint256 spent) {
        Plan storage p = _plans[id];
        if (!isExecutor[msg.sender] && msg.sender != p.owner) revert NotExecutor();
        if (!isDue(id) || shares == 0) revert NotDue();
        (uint256 cap, uint256[] memory perLeg) = capFor(id, shares);
        if (cap > p.amount) revert TooDear();
        uint256 amount = p.amount;
        uint256 tip = msg.sender == p.owner ? 0 : p.tip;
        _pull(p.owner, amount + tip);
        uint256 before = usdg.balanceOf(address(this));
        if (!usdg.approve(address(router), amount)) revert TransferFailed();
        router.buy(p.index, shares, amount, _fees[id], perLeg, p.owner);
        if (!usdg.approve(address(router), 0)) revert TransferFailed();
        uint256 back = usdg.balanceOf(address(this)) - (before - amount);
        spent = amount - back;
        if (back != 0) _push(p.owner, back);
        if (tip != 0) _push(msg.sender, tip);
        p.buysDone += 1;
        if (p.buysLeft != type(uint32).max) p.buysLeft -= 1;
        p.nextAt = uint40(block.timestamp) + p.interval;
        p.spent += uint128(spent);
        p.shares += uint128(shares);
        emit Bought(id, msg.sender, shares, spent, tip, p.nextAt);
    }

    function setPaused(uint256 id, bool paused) external {
        Plan storage p = _plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        if (p.cancelled) revert BadPlan();
        p.paused = paused;
        emit Paused(id, paused);
    }

    function cancel(uint256 id) external {
        Plan storage p = _plans[id];
        if (msg.sender != p.owner) revert NotOwner();
        p.cancelled = true;
        emit Cancelled(id);
    }

    function plan(uint256 id) external view returns (Plan memory) { return _plans[id]; }
    function feesOf(uint256 id) external view returns (uint24[] memory) { return _fees[id]; }
    function plansOf(address owner) external view returns (uint256[] memory) { return _byOwner[owner]; }
    function planCount() external view returns (uint256) { return _plans.length; }

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

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdg).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdg).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

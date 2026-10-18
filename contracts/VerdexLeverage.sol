// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Verdex Leverage: two-times long and short on tokenized stocks, built on Verdex Lend.
// A long: your USDG margin plus USDG borrowed from Lend buys the stock in its Uniswap v3 pool, in one
// transaction, and the stock is locked in Lend as the collateral for that loan. A short: your USDG
// margin is locked in a Lend market that lends the stock itself; the stock is borrowed, sold in the
// pool, and the USDG it fetched is locked next to your margin. Both are one swap with the pool paid
// inside the callback. Each wallet gets its own account contract, so each position is its own Lend
// position: its own health, its own liquidation, nothing shared. Open interest is capped per market.
// The hub holds nothing. The accounts hold nothing between transactions either: every position lives
// in Lend. No function moves funds to the owner.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

interface IVerdexLend {
    struct Market {
        address collateral; address loan; address pool; bool collateralIsToken0; bool enabled;
        uint16 ltvBps; uint16 liqThresholdBps; uint16 liqBonusBps; uint32 twapWindow;
        uint64 rateBaseBps; uint64 rateSlopeBps; uint64 lastAccrual;
        uint256 supplyCap; uint256 borrowCap; uint256 collateralCap;
        uint256 totalSupplyAssets; uint256 totalSupplyShares; uint256 totalBorrowAssets; uint256 totalBorrowShares;
        uint256 totalCollateral; uint256 reserves;
    }
    function market(uint256 id) external view returns (Market memory);
    function addCollateral(uint256 id, uint256 amount, address to) external;
    function removeCollateral(uint256 id, uint256 amount, address to) external;
    function borrow(uint256 id, uint256 assets, address to) external returns (uint256);
    function repay(uint256 id, uint256 assets, address onBehalf) external returns (uint256, uint256);
    function debtOf(uint256 id, address who) external view returns (uint256);
    function collateralOf(uint256 id, address who) external view returns (uint256);
    function health(uint256 id, address who) external view returns (uint256);
}

/// One per wallet. Owns that wallet's Lend positions and pays the pool inside the swap callback.
contract LeverageAccount {
    uint8 internal constant OPEN_LONG = 1;
    uint8 internal constant CLOSE_LONG = 2;
    uint8 internal constant OPEN_SHORT = 3;
    uint8 internal constant CLOSE_SHORT = 4;

    address public hub;
    address public user;
    address private _pool;
    uint256 private _before;

    error NotHub();
    error NotPool();
    error Initialised();
    error Failed();

    modifier onlyHub() { if (msg.sender != hub) revert NotHub(); _; }

    function init(address hub_, address user_) external {
        if (hub != address(0)) revert Initialised();
        hub = hub_; user = user_;
    }

    /// Runs one swap against `pool`; the callback does the Lend work described in `data`.
    function run(address pool, bool zeroForOne, int256 amountSpecified, address tokenOut, bytes calldata data) external onlyHub returns (int256 amount0, int256 amount1) {
        _pool = pool;
        _before = IERC20(tokenOut).balanceOf(address(this));
        (amount0, amount1) = IUniswapV3Pool(pool).swap(address(this), zeroForOne, amountSpecified, zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341, data);
        _pool = address(0);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        if (msg.sender == address(0) || msg.sender != _pool) revert NotPool();
        (uint8 kind, address lend, uint256 id, address tokenIn, address tokenOut, uint256 param) = abi.decode(data, (uint8, address, uint256, address, address, uint256));
        uint256 owed = d0 > 0 ? uint256(d0) : uint256(d1);
        uint256 got = IERC20(tokenOut).balanceOf(address(this)) - _before;
        if (kind == OPEN_LONG) {
            // got the stock: lock it, borrow the loan asset, pay the pool with margin plus loan
            _approve(tokenOut, lend, got);
            IVerdexLend(lend).addCollateral(id, got, address(this));
            IVerdexLend(lend).borrow(id, param, address(this));
        } else if (kind == CLOSE_LONG) {
            // got the loan asset: repay everything (unless margin already did), take the stock out, pay the pool with it
            uint256 debt = IVerdexLend(lend).debtOf(id, address(this));
            if (debt != 0) {
                _approve(tokenOut, lend, debt);
                IVerdexLend(lend).repay(id, type(uint256).max, address(this));
            }
            IVerdexLend(lend).removeCollateral(id, IVerdexLend(lend).collateralOf(id, address(this)), address(this));
        } else if (kind == OPEN_SHORT) {
            // got the loan asset (USDG) for the stock sold: lock it next to the margin, borrow the stock, pay the pool with it
            _approve(tokenOut, lend, got);
            IVerdexLend(lend).addCollateral(id, got, address(this));
            IVerdexLend(lend).borrow(id, param, address(this));
        } else if (kind == CLOSE_SHORT) {
            // got the stock: repay the stock debt, take the USDG out, pay the pool with it
            uint256 debt = IVerdexLend(lend).debtOf(id, address(this));
            if (debt != 0) {
                _approve(tokenOut, lend, debt);
                IVerdexLend(lend).repay(id, type(uint256).max, address(this));
            }
            IVerdexLend(lend).removeCollateral(id, IVerdexLend(lend).collateralOf(id, address(this)), address(this));
        } else revert Failed();
        if (!IERC20(tokenIn).transfer(msg.sender, owed)) revert Failed();
    }

    function lock(address lend, uint256 id, address token, uint256 amount) external onlyHub {
        _approve(token, lend, amount);
        IVerdexLend(lend).addCollateral(id, amount, address(this));
    }

    function repay(address lend, uint256 id, address token, uint256 amount) external onlyHub {
        _approve(token, lend, amount);
        IVerdexLend(lend).repay(id, amount, address(this));
    }

    function unlock(address lend, uint256 id, uint256 amount) external onlyHub {
        IVerdexLend(lend).removeCollateral(id, amount, address(this));
    }

    function sweep(address token, address to) external onlyHub returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0 && !IERC20(token).transfer(to, amount)) revert Failed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        if (!IERC20(token).approve(spender, amount)) revert Failed();
    }
}

contract VerdexLeverage {
    uint8 public constant LONG = 1;
    uint8 public constant SHORT = 2;
    uint256 private constant BPS = 10_000;

    struct Position { uint8 side; uint256 margin; uint256 exposure; uint64 openedAt; }

    IVerdexLend public immutable lend;
    address public immutable usdg;
    address public immutable verdex;
    address public immutable accountImpl;
    address public owner;
    address public treasury;
    uint16 public feeBps;

    mapping(address => address) public accountOf;
    mapping(uint256 => uint256) public maxExposure; // per Lend market, in USDG
    mapping(uint256 => uint256) public openInterest;
    mapping(address => mapping(uint256 => Position)) public positions;
    uint256 private _lock;

    event AccountCreated(address indexed user, address account);
    event Opened(address indexed user, uint256 indexed id, uint8 side, uint256 margin, uint256 exposure, uint256 units, uint256 fee);
    event Closed(address indexed user, uint256 indexed id, uint8 side, uint256 returned);
    event MarginAdded(address indexed user, uint256 indexed id, uint256 amount);
    event CapSet(uint256 indexed id, uint256 maxExposure);
    event FeeSet(uint16 feeBps);
    event TreasurySet(address treasury);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error Reentrancy();
    error BadArgs();
    error BadMarket();
    error CapReached();
    error Slippage();
    error NoPosition();
    error HasPosition();
    error Failed();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (_lock == 1) revert Reentrancy(); _lock = 1; _; _lock = 0; }

    constructor(address lend_, address usdg_, address verdex_, address treasury_, uint16 feeBps_) {
        if (lend_ == address(0) || usdg_ == address(0) || verdex_ == address(0) || treasury_ == address(0) || feeBps_ > 100) revert BadArgs();
        lend = IVerdexLend(lend_); usdg = usdg_; verdex = verdex_; treasury = treasury_; feeBps = feeBps_;
        accountImpl = address(new LeverageAccount());
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---- views ----

    function feeFor(address user, uint256 exposure) public view returns (uint256) {
        if (IERC20(verdex).balanceOf(user) > 0) return 0;
        return exposure * feeBps / BPS;
    }

    /// The Lend side of a position: collateral units, debt, health (bps, 10000 = the liquidation line).
    function status(address user, uint256 id) external view returns (Position memory p, uint256 collateral, uint256 debt, uint256 health) {
        p = positions[user][id];
        address a = accountOf[user];
        if (a == address(0)) return (p, 0, 0, type(uint256).max);
        collateral = lend.collateralOf(id, a);
        debt = lend.debtOf(id, a);
        health = lend.health(id, a);
    }

    // ---- open and close ----

    /// Long: `margin` USDG from you plus `borrow` USDG from Lend buy the stock of market `id` (a stock-collateral, USDG-loan market).
    function openLong(uint256 id, uint256 margin, uint256 borrow, uint256 minUnits) external nonReentrant returns (uint256 units) {
        IVerdexLend.Market memory m = lend.market(id);
        if (m.loan != usdg || !m.enabled) revert BadMarket();
        if (margin == 0 || borrow == 0 || borrow > margin) revert BadArgs();
        (address a, Position storage p) = _start(id, margin + borrow);
        uint256 fee = _fee(margin + borrow);
        _pull(usdg, msg.sender, a, margin);
        bytes memory data = abi.encode(uint8(1), address(lend), id, usdg, m.collateral, borrow);
        (int256 d0, int256 d1) = LeverageAccount(a).run(m.pool, !m.collateralIsToken0, int256(margin + borrow), m.collateral, data);
        units = uint256(-(m.collateralIsToken0 ? d0 : d1));
        if (units < minUnits) revert Slippage();
        p.side = LONG; p.margin = margin; p.exposure = margin + borrow; p.openedAt = uint64(block.timestamp);
        openInterest[id] += margin + borrow;
        LeverageAccount(a).sweep(usdg, msg.sender); // dust, if any
        emit Opened(msg.sender, id, LONG, margin, margin + borrow, units, fee);
    }

    /// Close a long: sell all the stock, repay the loan, the rest comes back to you in USDG.
    function closeLong(uint256 id, uint256 minOut) external nonReentrant returns (uint256 out) {
        IVerdexLend.Market memory m = lend.market(id);
        (address a, Position storage p) = _open(id, LONG);
        uint256 n = lend.collateralOf(id, a);
        if (n == 0) revert NoPosition();
        bytes memory data = abi.encode(uint8(2), address(lend), id, m.collateral, usdg, uint256(0));
        LeverageAccount(a).run(m.pool, m.collateralIsToken0, int256(n), usdg, data);
        out = LeverageAccount(a).sweep(usdg, msg.sender);
        LeverageAccount(a).sweep(m.collateral, msg.sender);
        if (out < minOut) revert Slippage();
        _finish(id, p);
        emit Closed(msg.sender, id, LONG, out);
    }

    /// Short: `margin` USDG from you is locked in market `id` (a USDG-collateral, stock-loan market); `units` of the stock are borrowed and sold, and the USDG they fetch is locked next to your margin.
    function openShort(uint256 id, uint256 margin, uint256 units, uint256 minProceeds) external nonReentrant returns (uint256 proceeds) {
        IVerdexLend.Market memory m = lend.market(id);
        if (m.collateral != usdg || !m.enabled) revert BadMarket();
        if (margin == 0 || units == 0) revert BadArgs();
        (address a, Position storage p) = _start(id, 0);
        _pull(usdg, msg.sender, a, margin);
        LeverageAccount(a).lock(address(lend), id, usdg, margin);
        bytes memory data = abi.encode(uint8(3), address(lend), id, m.loan, usdg, units);
        (int256 d0, int256 d1) = LeverageAccount(a).run(m.pool, m.collateralIsToken0 ? false : true, int256(units), usdg, data);
        proceeds = uint256(-(m.collateralIsToken0 ? d0 : d1));
        if (proceeds < minProceeds) revert Slippage();
        if (openInterest[id] + proceeds > maxExposure[id]) revert CapReached();
        uint256 fee = _fee(proceeds);
        p.side = SHORT; p.margin = margin; p.exposure = proceeds; p.openedAt = uint64(block.timestamp);
        openInterest[id] += proceeds;
        emit Opened(msg.sender, id, SHORT, margin, proceeds, units, fee);
    }

    /// Close a short: buy the stock back, repay it, your margin and what is left come back in USDG.
    function closeShort(uint256 id, uint256 minOut) external nonReentrant returns (uint256 out) {
        IVerdexLend.Market memory m = lend.market(id);
        (address a, Position storage p) = _open(id, SHORT);
        uint256 debt = lend.debtOf(id, a);
        if (debt == 0) revert NoPosition();
        bytes memory data = abi.encode(uint8(4), address(lend), id, usdg, m.loan, uint256(0));
        LeverageAccount(a).run(m.pool, m.collateralIsToken0, -int256(debt), m.loan, data);
        out = LeverageAccount(a).sweep(usdg, msg.sender);
        LeverageAccount(a).sweep(m.loan, msg.sender);
        if (out < minOut) revert Slippage();
        _finish(id, p);
        emit Closed(msg.sender, id, SHORT, out);
    }

    /// Improve the health of a position with USDG: a long repays part of its loan, a short adds collateral.
    function addMargin(uint256 id, uint256 amount) external nonReentrant {
        if (amount == 0) revert BadArgs();
        address a = accountOf[msg.sender];
        Position storage p = positions[msg.sender][id];
        if (a == address(0) || p.side == 0) revert NoPosition();
        if (p.side == LONG) {
            uint256 d = lend.debtOf(id, a);
            if (amount > d) amount = d;
            if (amount == 0) revert BadArgs();
            _pull(usdg, msg.sender, a, amount);
            LeverageAccount(a).repay(address(lend), id, usdg, amount);
        } else {
            _pull(usdg, msg.sender, a, amount);
            LeverageAccount(a).lock(address(lend), id, usdg, amount);
        }
        LeverageAccount(a).sweep(usdg, msg.sender);
        p.margin += amount;
        emit MarginAdded(msg.sender, id, amount);
    }

    /// After a Lend liquidation emptied a position, clear it here so the wallet can open again. Anything left in the account comes back.
    function settle(uint256 id) external nonReentrant {
        address a = accountOf[msg.sender];
        Position storage p = positions[msg.sender][id];
        if (a == address(0) || p.side == 0) revert NoPosition();
        if (lend.debtOf(id, a) != 0) revert HasPosition();
        IVerdexLend.Market memory m = lend.market(id);
        uint256 c = lend.collateralOf(id, a);
        if (c > 0) LeverageAccount(a).unlock(address(lend), id, c); // collateral left with no debt: it is yours
        uint8 side = p.side;
        LeverageAccount(a).sweep(usdg, msg.sender);
        LeverageAccount(a).sweep(m.loan == usdg ? m.collateral : m.loan, msg.sender);
        _finish(id, p);
        emit Closed(msg.sender, id, side, 0);
    }

    // ---- owner ----

    function setCap(uint256 id, uint256 max) external onlyOwner { maxExposure[id] = max; emit CapSet(id, max); }
    function setCaps(uint256[] calldata ids, uint256[] calldata maxes) external onlyOwner {
        if (ids.length != maxes.length) revert BadArgs();
        for (uint256 i = 0; i < ids.length; i++) { maxExposure[ids[i]] = maxes[i]; emit CapSet(ids[i], maxes[i]); }
    }
    function setFee(uint16 bps) external onlyOwner { if (bps > 100) revert BadArgs(); feeBps = bps; emit FeeSet(bps); }
    function setTreasury(address t) external onlyOwner { if (t == address(0)) revert BadArgs(); treasury = t; emit TreasurySet(t); }
    function transferOwnership(address to) external onlyOwner { if (to == address(0)) revert BadArgs(); emit OwnershipTransferred(owner, to); owner = to; }

    // ---- internals ----

    function _start(uint256 id, uint256 exposure) private returns (address a, Position storage p) {
        a = accountOf[msg.sender];
        if (a == address(0)) { a = _clone(accountImpl); LeverageAccount(a).init(address(this), msg.sender); accountOf[msg.sender] = a; emit AccountCreated(msg.sender, a); }
        p = positions[msg.sender][id];
        if (p.side != 0) revert HasPosition();
        if (exposure > 0 && openInterest[id] + exposure > maxExposure[id]) revert CapReached();
    }

    function _open(uint256 id, uint8 side) private view returns (address a, Position storage p) {
        a = accountOf[msg.sender];
        p = positions[msg.sender][id];
        if (a == address(0) || p.side != side) revert NoPosition();
    }

    function _finish(uint256 id, Position storage p) private {
        openInterest[id] = openInterest[id] > p.exposure ? openInterest[id] - p.exposure : 0;
        delete positions[msg.sender][id];
    }

    function _fee(uint256 exposure) private returns (uint256 fee) {
        fee = feeFor(msg.sender, exposure);
        if (fee > 0) _pull(usdg, msg.sender, treasury, fee);
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        if (!IERC20(token).transferFrom(from, to, amount)) revert Failed();
    }

    function _clone(address impl) private returns (address instance) {
        bytes20 target = bytes20(impl);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), target)
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert Failed();
    }
}

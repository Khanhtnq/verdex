// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Verdex Lend: isolated money markets for tokenized stocks on Robinhood Chain.
// Each market pairs one collateral token with one loan asset: a stock against USDG (borrow dollars
// against your shares) or USDG against a stock (borrow shares, which is what a short needs). Suppliers
// deposit the loan asset and earn the interest borrowers pay; borrowers lock the collateral and draw
// the loan asset against it. Markets are isolated: one pair, its own loan-to-value, its own caps;
// nothing spills over. Prices come from the pair's Uniswap v3 pool: the lower collateral value of spot
// and a time-weighted average for borrowing, the higher for liquidation, so a single manipulated block
// cannot open or close a loan.
// The owner keeps caps and parameters and nothing else: there is no function that moves funds to
// the owner. A share of the interest (reserveBps) is kept for the treasury, where it buys VERDEX.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory);
    function observations(uint256 index) external view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized);
}

contract VerdexLend {
    struct Market {
        address collateral;      // what the borrower locks
        address loan;            // what is lent and borrowed
        address pool;            // Uniswap v3 pool of collateral/loan
        bool collateralIsToken0; // token ordering in the pool
        bool enabled;
        uint16 ltvBps;           // max debt / collateral value when borrowing
        uint16 liqThresholdBps;  // debt / collateral value above which anyone can liquidate
        uint16 liqBonusBps;      // extra collateral a liquidator receives
        uint32 twapWindow;       // seconds; 0 = spot only
        uint64 rateBaseBps;      // borrow APR at zero utilisation, bps
        uint64 rateSlopeBps;     // added APR at full utilisation, bps
        uint64 lastAccrual;
        uint256 supplyCap;       // loan asset
        uint256 borrowCap;       // loan asset
        uint256 collateralCap;   // collateral units
        uint256 totalSupplyAssets;
        uint256 totalSupplyShares;
        uint256 totalBorrowAssets;
        uint256 totalBorrowShares;
        uint256 totalCollateral;
        uint256 reserves;        // loan asset kept for the treasury
    }

    uint256 private constant YEAR = 365 days;
    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 2 ** 96;
    uint16 public constant MIN_CARDINALITY = 1800; // observations a pool must keep before it can price a market

    address public owner;
    address public treasury;
    uint16 public reserveBps = 1000; // 10% of interest

    Market[] private _markets;
    mapping(uint256 => mapping(address => uint256)) public supplyShares;
    mapping(uint256 => mapping(address => uint256)) public borrowShares;
    mapping(uint256 => mapping(address => uint256)) public collateralOf;
    /// Where a market's reserves go when skimmed: the treasury, or another sink for loan assets the treasury cannot use.
    mapping(uint256 => address) public skimTo;

    uint256 private _lock;

    event MarketCreated(uint256 indexed id, address indexed collateral, address indexed loan, address pool);
    event Supplied(uint256 indexed id, address indexed who, address indexed to, uint256 assets, uint256 shares);
    event Withdrawn(uint256 indexed id, address indexed who, address indexed to, uint256 assets, uint256 shares);
    event CollateralAdded(uint256 indexed id, address indexed who, address indexed to, uint256 amount);
    event CollateralRemoved(uint256 indexed id, address indexed who, address indexed to, uint256 amount);
    event Borrowed(uint256 indexed id, address indexed who, address indexed to, uint256 assets, uint256 shares);
    event Repaid(uint256 indexed id, address indexed who, address indexed onBehalf, uint256 assets, uint256 shares);
    event Liquidated(uint256 indexed id, address indexed liquidator, address indexed borrower, uint256 repaid, uint256 seized);
    event Accrued(uint256 indexed id, uint256 interest, uint256 reserve);
    event Skimmed(uint256 indexed id, uint256 amount);
    event BadDebt(uint256 indexed id, address indexed borrower, uint256 written_off);
    event SkimToSet(uint256 indexed id, address to);
    event CapsSet(uint256 indexed id, uint256 supplyCap, uint256 borrowCap, uint256 collateralCap);
    event ParamsSet(uint256 indexed id, uint16 ltvBps, uint16 liqThresholdBps, uint16 liqBonusBps, uint32 twapWindow, uint64 rateBaseBps, uint64 rateSlopeBps);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TreasurySet(address indexed treasury);

    error NotOwner();
    error Reentrancy();
    error BadArgs();
    error BadMarket();
    error Disabled();
    error CapReached();
    error Insufficient();
    error Unhealthy();
    error Healthy();
    error ZeroShares();
    error NoOracle();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (_lock == 1) revert Reentrancy(); _lock = 1; _; _lock = 0; }

    constructor(address treasury_) {
        if (treasury_ == address(0)) revert BadArgs();
        treasury = treasury_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---- views ----

    function marketCount() external view returns (uint256) { return _markets.length; }
    function market(uint256 id) external view returns (Market memory) { return _markets[id]; }

    /// Collateral value in the loan asset for `amount` units: the lower of spot and the time-weighted
    /// value when borrowing (`forBorrow`), the higher of the two when checking a liquidation.
    function collateralValue(uint256 id, uint256 amount, bool forBorrow) public view returns (uint256) {
        Market storage m = _markets[id];
        (uint160 spot, uint160 twap) = _prices(m);
        uint256 a = _value(amount, spot, m.collateralIsToken0);
        if (twap == 0) return a; // twapWindow == 0: spot only, by the owner's explicit choice
        uint256 b = _value(amount, twap, m.collateralIsToken0);
        return forBorrow ? (a < b ? a : b) : (a > b ? a : b);
    }

    /// The price one collateral unit is handed over at in a liquidation: the lower of spot and the time-weighted
    /// price, but never more than the bonus below the time-weighted one, so a one-block dump cannot seize more
    /// than about twice the bonus and a lagging average cannot make liquidation unprofitable.
    function seizePrice(uint256 id) public view returns (uint256) {
        Market storage m = _markets[id];
        (uint160 spot, uint160 twap) = _prices(m);
        uint256 a = _value(1e18, spot, m.collateralIsToken0);
        if (twap == 0) return a;
        uint256 b = _value(1e18, twap, m.collateralIsToken0);
        uint256 floor_ = b * (BPS - m.liqBonusBps) / BPS;
        uint256 v = a < b ? a : b;
        return v < floor_ ? floor_ : v;
    }

    function debtOf(uint256 id, address who) public view returns (uint256) {
        Market storage m = _markets[id];
        (uint256 borrowAssets,,) = _accruedView(m);
        uint256 shares = borrowShares[id][who];
        if (shares == 0) return 0;
        return _mulDivUp(shares, borrowAssets, m.totalBorrowShares);
    }

    function suppliedOf(uint256 id, address who) external view returns (uint256) {
        Market storage m = _markets[id];
        (, uint256 supplyAssets,) = _accruedView(m);
        uint256 shares = supplyShares[id][who];
        if (shares == 0 || m.totalSupplyShares == 0) return 0;
        return shares * supplyAssets / m.totalSupplyShares;
    }

    /// Current borrow APR in bps and supply APR in bps (after the reserve share).
    function rates(uint256 id) external view returns (uint256 borrowAprBps, uint256 supplyAprBps, uint256 utilisationBps) {
        Market storage m = _markets[id];
        utilisationBps = m.totalSupplyAssets == 0 ? 0 : m.totalBorrowAssets * BPS / m.totalSupplyAssets;
        if (utilisationBps > BPS) utilisationBps = BPS;
        borrowAprBps = uint256(m.rateBaseBps) + uint256(m.rateSlopeBps) * utilisationBps / BPS;
        supplyAprBps = borrowAprBps * utilisationBps / BPS * (BPS - reserveBps) / BPS;
    }

    /// Max loan asset `who` could still borrow in market `id` at the borrow price.
    function borrowable(uint256 id, address who) external view returns (uint256) {
        Market storage m = _markets[id];
        uint256 limit = collateralValue(id, collateralOf[id][who], true) * m.ltvBps / BPS;
        uint256 debt = debtOf(id, who);
        if (debt >= limit) return 0;
        uint256 room = limit - debt;
        uint256 liquidity = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
        if (room > liquidity) room = liquidity;
        uint256 capRoom = m.borrowCap > m.totalBorrowAssets ? m.borrowCap - m.totalBorrowAssets : 0;
        return room > capRoom ? capRoom : room;
    }

    /// Health factor in bps: liquidation threshold value / debt. Above 10000 is safe. type(uint256).max with no debt.
    function health(uint256 id, address who) external view returns (uint256) {
        uint256 debt = debtOf(id, who);
        if (debt == 0) return type(uint256).max;
        Market storage m = _markets[id];
        return collateralValue(id, collateralOf[id][who], false) * m.liqThresholdBps / debt;
    }

    // ---- supply side ----

    function supply(uint256 id, uint256 assets, address to) external nonReentrant returns (uint256 shares) {
        Market storage m = _enabled(id);
        _accrue(id, m);
        if (assets == 0) revert BadArgs();
        if (m.totalSupplyAssets + assets > m.supplyCap) revert CapReached();
        shares = m.totalSupplyShares == 0 ? assets : assets * m.totalSupplyShares / m.totalSupplyAssets;
        if (shares == 0) revert ZeroShares();
        m.totalSupplyAssets += assets;
        m.totalSupplyShares += shares;
        supplyShares[id][to] += shares;
        _pull(IERC20(m.loan), msg.sender, assets);
        emit Supplied(id, msg.sender, to, assets, shares);
    }

    function withdraw(uint256 id, uint256 shares, address to) external nonReentrant returns (uint256 assets) {
        Market storage m = _markets[id];
        _accrue(id, m);
        if (shares == 0 || shares > supplyShares[id][msg.sender]) revert Insufficient();
        assets = shares * m.totalSupplyAssets / m.totalSupplyShares;
        if (assets > _available(m)) revert Insufficient(); // lent out
        supplyShares[id][msg.sender] -= shares;
        m.totalSupplyShares -= shares;
        m.totalSupplyAssets -= assets;
        _push(IERC20(m.loan), to, assets);
        emit Withdrawn(id, msg.sender, to, assets, shares);
    }

    // ---- borrow side ----

    /// Allowed while a market is disabled too, so a borrower can always defend a position.
    function addCollateral(uint256 id, uint256 amount, address to) external nonReentrant {
        if (id >= _markets.length) revert BadMarket();
        Market storage m = _markets[id];
        if (amount == 0) revert BadArgs();
        if (m.totalCollateral + amount > m.collateralCap) revert CapReached();
        collateralOf[id][to] += amount;
        m.totalCollateral += amount;
        _pull(IERC20(m.collateral), msg.sender, amount);
        emit CollateralAdded(id, msg.sender, to, amount);
    }

    function removeCollateral(uint256 id, uint256 amount, address to) external nonReentrant {
        Market storage m = _markets[id];
        _accrue(id, m);
        if (amount == 0 || amount > collateralOf[id][msg.sender]) revert Insufficient();
        collateralOf[id][msg.sender] -= amount;
        m.totalCollateral -= amount;
        if (!_healthyForBorrow(id, m, msg.sender)) revert Unhealthy();
        _push(IERC20(m.collateral), to, amount);
        emit CollateralRemoved(id, msg.sender, to, amount);
    }

    function borrow(uint256 id, uint256 assets, address to) external nonReentrant returns (uint256 shares) {
        Market storage m = _enabled(id);
        _accrue(id, m);
        if (assets == 0) revert BadArgs();
        if (m.totalBorrowAssets + assets > m.borrowCap) revert CapReached();
        if (assets > _available(m)) revert Insufficient();
        shares = m.totalBorrowShares == 0 ? assets : _mulDivUp(assets, m.totalBorrowShares, m.totalBorrowAssets);
        m.totalBorrowAssets += assets;
        m.totalBorrowShares += shares;
        borrowShares[id][msg.sender] += shares;
        if (!_healthyForBorrow(id, m, msg.sender)) revert Unhealthy();
        _push(IERC20(m.loan), to, assets);
        emit Borrowed(id, msg.sender, to, assets, shares);
    }

    /// Repay up to `assets` of `onBehalf`'s debt in the loan asset. Pass type(uint256).max to repay everything.
    function repay(uint256 id, uint256 assets, address onBehalf) external nonReentrant returns (uint256 repaid, uint256 shares) {
        Market storage m = _markets[id];
        _accrue(id, m);
        uint256 owed = borrowShares[id][onBehalf];
        if (owed == 0) revert Insufficient();
        uint256 debt = _mulDivUp(owed, m.totalBorrowAssets, m.totalBorrowShares);
        repaid = assets >= debt ? debt : assets;
        shares = repaid == debt ? owed : repaid * m.totalBorrowShares / m.totalBorrowAssets;
        if (shares == 0) revert ZeroShares();
        borrowShares[id][onBehalf] = owed - shares;
        m.totalBorrowShares -= shares;
        m.totalBorrowAssets = repaid >= m.totalBorrowAssets ? 0 : m.totalBorrowAssets - repaid;
        _pull(IERC20(m.loan), msg.sender, repaid);
        emit Repaid(id, msg.sender, onBehalf, repaid, shares);
    }

    /// Repay part of an unhealthy borrower's debt and take collateral worth it plus the bonus, at the liquidation price.
    function liquidate(uint256 id, address borrower, uint256 assets) external nonReentrant returns (uint256 repaid, uint256 seized) {
        Market storage m = _markets[id];
        _accrue(id, m);
        uint256 owed = borrowShares[id][borrower];
        if (owed == 0) revert Healthy();
        uint256 debt = _mulDivUp(owed, m.totalBorrowAssets, m.totalBorrowShares);
        uint256 coll = collateralOf[id][borrower];
        uint256 value = collateralValue(id, coll, false);
        if (value * m.liqThresholdBps / BPS >= debt) revert Healthy();
        repaid = assets >= debt ? debt : assets;
        if (repaid == 0) revert BadArgs();
        // collateral worth repaid * (1 + bonus) at the seize price; capped at what the borrower has
        uint256 unitValue = seizePrice(id);
        seized = unitValue == 0 ? coll : repaid * (BPS + m.liqBonusBps) / BPS * 1e18 / unitValue;
        if (seized > coll) seized = coll;
        uint256 shares = repaid == debt ? owed : repaid * m.totalBorrowShares / m.totalBorrowAssets;
        if (shares == 0) revert ZeroShares();
        borrowShares[id][borrower] = owed - shares;
        m.totalBorrowShares -= shares;
        m.totalBorrowAssets = repaid >= m.totalBorrowAssets ? 0 : m.totalBorrowAssets - repaid;
        collateralOf[id][borrower] = coll - seized;
        m.totalCollateral -= seized;
        // No collateral left and debt remains: write it off against the reserves first, then the suppliers,
        // instead of leaving phantom assets that the last supplier could never withdraw.
        if (seized == coll && borrowShares[id][borrower] != 0) {
            uint256 remShares = borrowShares[id][borrower];
            uint256 rem = _mulDivUp(remShares, m.totalBorrowAssets, m.totalBorrowShares);
            if (rem > m.totalBorrowAssets) rem = m.totalBorrowAssets;
            borrowShares[id][borrower] = 0;
            m.totalBorrowShares -= remShares;
            m.totalBorrowAssets -= rem;
            uint256 fromReserves = rem < m.reserves ? rem : m.reserves;
            m.reserves -= fromReserves;
            uint256 fromSupply = rem - fromReserves;
            m.totalSupplyAssets = fromSupply >= m.totalSupplyAssets ? 0 : m.totalSupplyAssets - fromSupply;
            emit BadDebt(id, borrower, rem);
        }
        _pull(IERC20(m.loan), msg.sender, repaid);
        _push(IERC20(m.collateral), msg.sender, seized);
        emit Liquidated(id, msg.sender, borrower, repaid, seized);
    }

    /// Anyone: send the reserve share of interest to the market's sink (the treasury, where it buys VERDEX, for
    /// USDG markets; another address the owner names for stock-loan markets the treasury cannot swap).
    function skim(uint256 id) external nonReentrant returns (uint256 amount) {
        Market storage m = _markets[id];
        _accrue(id, m);
        amount = m.reserves;
        if (amount == 0) return 0;
        m.reserves = 0;
        address to = skimTo[id] == address(0) ? treasury : skimTo[id];
        _push(IERC20(m.loan), to, amount);
        emit Skimmed(id, amount);
    }

    function accrue(uint256 id) external { _accrue(id, _markets[id]); }

    // ---- owner ----

    function createMarket(address collateral, address loan, address pool, uint16 ltvBps, uint16 liqThresholdBps, uint16 liqBonusBps, uint32 twapWindow, uint64 rateBaseBps, uint64 rateSlopeBps, uint256 supplyCap, uint256 borrowCap, uint256 collateralCap) external onlyOwner returns (uint256 id) {
        if (collateral == address(0) || loan == address(0) || pool == address(0) || collateral == loan) revert BadArgs();
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        bool c0 = t0 == collateral && t1 == loan;
        if (!c0 && !(t1 == collateral && t0 == loan)) revert BadMarket();
        _checkParams(ltvBps, liqThresholdBps, liqBonusBps);
        if (twapWindow != 0) {
            (,,, uint16 cardinality,,,) = IUniswapV3Pool(pool).slot0();
            if (cardinality < MIN_CARDINALITY) revert BadMarket(); // the pool must keep enough history for the window
        }
        id = _markets.length;
        _markets.push();
        Market storage m = _markets[id];
        skimTo[id] = treasury;
        m.collateral = collateral; m.loan = loan; m.pool = pool; m.collateralIsToken0 = c0; m.enabled = true;
        m.ltvBps = ltvBps; m.liqThresholdBps = liqThresholdBps; m.liqBonusBps = liqBonusBps; m.twapWindow = twapWindow;
        m.rateBaseBps = rateBaseBps; m.rateSlopeBps = rateSlopeBps; m.lastAccrual = uint64(block.timestamp);
        m.supplyCap = supplyCap; m.borrowCap = borrowCap; m.collateralCap = collateralCap;
        emit MarketCreated(id, collateral, loan, pool);
        emit ParamsSet(id, ltvBps, liqThresholdBps, liqBonusBps, twapWindow, rateBaseBps, rateSlopeBps);
        emit CapsSet(id, supplyCap, borrowCap, collateralCap);
    }

    function setCaps(uint256 id, uint256 supplyCap, uint256 borrowCap, uint256 collateralCap) external onlyOwner {
        Market storage m = _markets[id];
        m.supplyCap = supplyCap; m.borrowCap = borrowCap; m.collateralCap = collateralCap;
        emit CapsSet(id, supplyCap, borrowCap, collateralCap);
    }

    function setParams(uint256 id, uint16 ltvBps, uint16 liqThresholdBps, uint16 liqBonusBps, uint32 twapWindow, uint64 rateBaseBps, uint64 rateSlopeBps) external onlyOwner {
        _checkParams(ltvBps, liqThresholdBps, liqBonusBps);
        Market storage m = _markets[id];
        _accrue(id, m);
        m.ltvBps = ltvBps; m.liqThresholdBps = liqThresholdBps; m.liqBonusBps = liqBonusBps; m.twapWindow = twapWindow;
        m.rateBaseBps = rateBaseBps; m.rateSlopeBps = rateSlopeBps;
        emit ParamsSet(id, ltvBps, liqThresholdBps, liqBonusBps, twapWindow, rateBaseBps, rateSlopeBps);
    }

    function setEnabled(uint256 id, bool on) external onlyOwner { _markets[id].enabled = on; }
    /// Where market `id`'s reserves (the protocol's share of interest, never user funds) are skimmed to.
    function setSkimTo(uint256 id, address to) external onlyOwner { if (to == address(0) || id >= _markets.length) revert BadArgs(); skimTo[id] = to; emit SkimToSet(id, to); }
    function setReserveBps(uint16 bps) external onlyOwner { if (bps > 5000) revert BadArgs(); reserveBps = bps; }
    function setTreasury(address t) external onlyOwner { if (t == address(0)) revert BadArgs(); treasury = t; emit TreasurySet(t); }
    function transferOwnership(address to) external onlyOwner { if (to == address(0)) revert BadArgs(); emit OwnershipTransferred(owner, to); owner = to; }

    // ---- internals ----

    function _enabled(uint256 id) private view returns (Market storage m) {
        if (id >= _markets.length) revert BadMarket();
        m = _markets[id];
        if (!m.enabled) revert Disabled();
    }

    function _checkParams(uint16 ltvBps, uint16 liqThresholdBps, uint16 liqBonusBps) private pure {
        if (ltvBps == 0 || ltvBps > liqThresholdBps || liqThresholdBps > 9000 || liqBonusBps > 2000) revert BadArgs();
        if (uint256(liqThresholdBps) * (BPS + liqBonusBps) / BPS >= BPS) revert BadArgs(); // bonus must fit under the threshold
    }

    function _accruedView(Market storage m) private view returns (uint256 borrowAssets, uint256 supplyAssets, uint256 reserve) {
        borrowAssets = m.totalBorrowAssets; supplyAssets = m.totalSupplyAssets;
        uint256 dt = block.timestamp - m.lastAccrual;
        if (dt == 0 || borrowAssets == 0 || supplyAssets == 0) return (borrowAssets, supplyAssets, 0);
        uint256 util = borrowAssets * BPS / supplyAssets;
        if (util > BPS) util = BPS;
        uint256 apr = uint256(m.rateBaseBps) + uint256(m.rateSlopeBps) * util / BPS;
        uint256 interest = borrowAssets * apr * dt / (BPS * YEAR);
        reserve = interest * reserveBps / BPS;
        borrowAssets += interest;
        supplyAssets += interest - reserve;
    }

    function _accrue(uint256 id, Market storage m) private {
        (uint256 b, uint256 s, uint256 r) = _accruedView(m);
        if (m.lastAccrual != uint64(block.timestamp)) {
            uint256 interest = b - m.totalBorrowAssets;
            m.totalBorrowAssets = b; m.totalSupplyAssets = s; m.reserves += r;
            m.lastAccrual = uint64(block.timestamp);
            if (interest > 0) emit Accrued(id, interest, r);
        }
    }

    function _healthyForBorrow(uint256 id, Market storage m, address who) private view returns (bool) {
        uint256 shares = borrowShares[id][who];
        if (shares == 0) return true;
        uint256 debt = _mulDivUp(shares, m.totalBorrowAssets, m.totalBorrowShares);
        return collateralValue(id, collateralOf[id][who], true) * m.ltvBps / BPS >= debt;
    }

    /// Spot and time-weighted sqrt prices. The average is over `twapWindow`; if the pool's history is shorter
    /// (it was just created, or someone is writing an observation every block to push the window out) the
    /// longest window the pool still has is used, as long as it is at least half the configured one. Shorter
    /// than that, pricing refuses rather than fall back to the manipulable spot.
    function _prices(Market storage m) private view returns (uint160 spot, uint160 twap) {
        uint16 index; uint16 cardinality;
        (spot,, index, cardinality,,,) = IUniswapV3Pool(m.pool).slot0();
        if (m.twapWindow == 0) return (spot, 0);
        uint32 window = m.twapWindow;
        (uint32 oldest,,, bool initialized) = IUniswapV3Pool(m.pool).observations((uint256(index) + 1) % cardinality);
        if (!initialized) (oldest,,,) = IUniswapV3Pool(m.pool).observations(0);
        uint256 age = block.timestamp - oldest;
        if (age < window) {
            if (age < window / 2) revert NoOracle();
            window = uint32(age);
        }
        uint32[] memory ago = new uint32[](2);
        ago[0] = window; ago[1] = 0;
        (int56[] memory cum,) = IUniswapV3Pool(m.pool).observe(ago);
        int56 delta = cum[1] - cum[0];
        int24 tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
        twap = _sqrtAtTick(tick);
    }

    function _available(Market storage m) private view returns (uint256) {
        return m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
    }

    /// Loan-asset value of `amount` collateral units at sqrtPriceX96 `p` (token1 per token0).
    function _value(uint256 amount, uint160 p, bool collateralIsToken0) private pure returns (uint256) {
        if (amount == 0 || p == 0) return 0;
        if (collateralIsToken0) {
            uint256 v = amount * p / Q96;
            return v * p / Q96;
        } else {
            uint256 v = amount * Q96 / p;
            return v * Q96 / p;
        }
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        if (d == 0) return 0;
        return (a * b + d - 1) / d;
    }

    function _pull(IERC20 t, address from, uint256 amount) private {
        uint256 before = t.balanceOf(address(this));
        if (!t.transferFrom(from, address(this), amount)) revert Insufficient();
        if (t.balanceOf(address(this)) - before != amount) revert Insufficient();
    }

    function _push(IERC20 t, address to, uint256 amount) private {
        if (!t.transfer(to, amount)) revert Insufficient();
    }

    // Uniswap v3 TickMath.getSqrtRatioAtTick, unchanged.
    function _sqrtAtTick(int24 tick) private pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "T");
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}

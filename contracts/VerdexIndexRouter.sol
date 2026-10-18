// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Verdex Index Router
/// @notice Buys and sells index shares with USDG in one transaction. `buy` swaps USDG for exactly the units
///         behind the shares in each component's Uniswap v3 pool, issues the shares to the buyer and refunds
///         the USDG it did not need. `sell` redeems the shares and swaps every unit back to USDG. Each leg
///         carries a limit the caller sets, so a thin or moved pool makes the trade revert, not fill badly.
///         A small fee on the USDG side goes to the treasury, and is waived for wallets holding VERDEX.
///         The router holds nothing between transactions.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

interface IVerdexIndex {
    function components() external view returns (address[] memory tokens, uint256[] memory units);
    function amountsIn(uint256 shares) external view returns (uint256[] memory);
    function amountsOut(uint256 shares) external view returns (uint256[] memory);
    function issue(uint256 shares, address to) external;
    function redeem(uint256 shares, address to) external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract VerdexIndexRouter {
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint16 public constant MAX_FEE_BPS = 100;

    IUniswapV3Factory public immutable factory;
    address public immutable usdg;
    address public immutable verdex;
    address public owner;
    address public treasury;
    uint16 public feeBps;
    address private _activePool;
    bool private _locked;

    event Bought(address indexed index, address indexed buyer, address indexed to, uint256 shares, uint256 usdgIn, uint256 fee);
    event Sold(address indexed index, address indexed seller, address indexed to, uint256 shares, uint256 usdgOut, uint256 fee);
    event FeeSet(uint16 feeBps);
    event TreasurySet(address treasury);
    event OwnershipTransferred(address indexed from, address indexed to);

    error Reentrancy();
    error NotOwner();
    error BadArgs();
    error NoPool();
    error Short();
    error Slippage();
    error BadCallback();
    error FeeTooHigh();

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IUniswapV3Factory factory_, address usdg_, address verdex_, address treasury_, uint16 feeBps_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        factory = factory_;
        usdg = usdg_;
        verdex = verdex_;
        owner = msg.sender;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ----- Quotes at the pool spot price, no price impact -----

    /// @notice USDG needed for `shares` at each pool's spot price, per leg and in total.
    function spotIn(address index, uint256 shares, uint24[] calldata fees) external view returns (uint256 total, uint256[] memory perLeg) {
        (address[] memory tokens,) = IVerdexIndex(index).components();
        uint256[] memory amounts = IVerdexIndex(index).amountsIn(shares);
        perLeg = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            IUniswapV3Pool pool = _pool(tokens[i], fees[i]);
            (uint160 sqrtP,,,,,,) = pool.slot0();
            bool usdgIsToken0 = pool.token0() == usdg;
            // price of token1 in token0 is sqrtP^2 / 2^192; done in two steps so nothing overflows
            uint256 v;
            if (usdgIsToken0) { v = (amounts[i] << 96) / sqrtP; v = (v << 96) / sqrtP; }
            else { v = (amounts[i] * sqrtP) >> 96; v = (v * sqrtP) >> 96; }
            perLeg[i] = v;
            total += v;
        }
    }

    /// @notice USDG `shares` would return at each pool's spot price, per leg and in total.
    function spotOut(address index, uint256 shares, uint24[] calldata fees) external view returns (uint256 total, uint256[] memory perLeg) {
        (address[] memory tokens,) = IVerdexIndex(index).components();
        uint256[] memory amounts = IVerdexIndex(index).amountsOut(shares);
        perLeg = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            IUniswapV3Pool pool = _pool(tokens[i], fees[i]);
            (uint160 sqrtP,,,,,,) = pool.slot0();
            bool tokenIsToken0 = pool.token0() == tokens[i];
            uint256 v;
            if (tokenIsToken0) { v = (amounts[i] * sqrtP) >> 96; v = (v * sqrtP) >> 96; }
            else { v = (amounts[i] << 96) / sqrtP; v = (v << 96) / sqrtP; }
            perLeg[i] = v;
            total += v;
        }
    }

    // ----- Buy and sell -----

    /// @notice Buys `shares` of `index` for at most `maxIn` USDG, with a cap per leg, and issues them to `to`.
    ///         Unspent USDG is refunded. Returns the USDG spent on the swaps, before the fee.
    function buy(address index, uint256 shares, uint256 maxIn, uint24[] calldata fees, uint256[] calldata maxInPerLeg, address to) external nonReentrant returns (uint256 spent) {
        (address[] memory tokens,) = IVerdexIndex(index).components();
        uint256 n = tokens.length;
        if (fees.length != n || maxInPerLeg.length != n || shares == 0) revert BadArgs();
        uint256[] memory amounts = IVerdexIndex(index).amountsIn(shares);
        _pull(usdg, msg.sender, maxIn);
        for (uint256 i = 0; i < n; i++) {
            IUniswapV3Pool pool = _pool(tokens[i], fees[i]);
            bool zeroForOne = pool.token0() == usdg;
            _activePool = address(pool);
            (int256 a0, int256 a1) = pool.swap(address(this), zeroForOne, -int256(amounts[i]), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(usdg));
            _activePool = address(0);
            uint256 inAmt = uint256(zeroForOne ? a0 : a1);
            uint256 outAmt = uint256(-(zeroForOne ? a1 : a0));
            if (outAmt < amounts[i]) revert Short();
            if (inAmt > maxInPerLeg[i]) revert Slippage();
            spent += inAmt;
            _approve(tokens[i], index, amounts[i]);
        }
        uint256 fee = _fee(spent);
        if (spent + fee > maxIn) revert Slippage();
        IVerdexIndex(index).issue(shares, to);
        if (fee != 0) _send(usdg, treasury, fee);
        uint256 refund = maxIn - spent - fee;
        if (refund != 0) _send(usdg, msg.sender, refund);
        emit Bought(index, msg.sender, to, shares, spent, fee);
    }

    /// @notice Redeems `shares` of `index` from the caller, sells every unit for USDG and sends at least
    ///         `minOut` (after the fee) to `to`. Returns the USDG received from the swaps, before the fee.
    function sell(address index, uint256 shares, uint256 minOut, uint24[] calldata fees, uint256[] calldata minOutPerLeg, address to) external nonReentrant returns (uint256 received) {
        (address[] memory tokens,) = IVerdexIndex(index).components();
        uint256 n = tokens.length;
        if (fees.length != n || minOutPerLeg.length != n || shares == 0) revert BadArgs();
        uint256[] memory amounts = IVerdexIndex(index).amountsOut(shares);
        require(IVerdexIndex(index).transferFrom(msg.sender, address(this), shares), "pull");
        IVerdexIndex(index).redeem(shares, address(this));
        for (uint256 i = 0; i < n; i++) {
            if (amounts[i] == 0) continue;
            IUniswapV3Pool pool = _pool(tokens[i], fees[i]);
            bool zeroForOne = pool.token0() == tokens[i];
            _activePool = address(pool);
            (int256 a0, int256 a1) = pool.swap(address(this), zeroForOne, int256(amounts[i]), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(tokens[i]));
            _activePool = address(0);
            uint256 inAmt = uint256(zeroForOne ? a0 : a1);
            uint256 outAmt = uint256(-(zeroForOne ? a1 : a0));
            if (inAmt < amounts[i]) revert Short();
            if (outAmt < minOutPerLeg[i]) revert Slippage();
            received += outAmt;
        }
        uint256 fee = _fee(received);
        if (received - fee < minOut) revert Slippage();
        if (fee != 0) _send(usdg, treasury, fee);
        _send(usdg, to, received - fee);
        emit Sold(index, msg.sender, to, shares, received, fee);
    }

    /// @dev Pays the pool what it is owed, only while a swap started here is in flight.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _activePool || _activePool == address(0)) revert BadCallback();
        address tokenIn = abi.decode(data, (address));
        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        _send(tokenIn, msg.sender, owed);
    }

    // ----- Owner: the fee and where it goes -----

    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function transferOwnership(address to) external onlyOwner {
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// @notice Sends any token left in the router (rounding dust) to the treasury. The router keeps no balances by design.
    function sweep(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal != 0) _send(token, treasury, bal);
    }

    // ----- Internals -----

    function _fee(uint256 amount) private view returns (uint256) {
        if (feeBps == 0 || IERC20(verdex).balanceOf(msg.sender) > 0) return 0;
        return (amount * feeBps) / 10_000;
    }

    function _pool(address token, uint24 fee) private view returns (IUniswapV3Pool pool) {
        pool = IUniswapV3Pool(factory.getPool(usdg, token, fee));
        if (address(pool) == address(0)) revert NoPool();
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "pull");
    }

    function _send(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "send");
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "approve");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Verdex Treasury
/// @notice Where every protocol fee lands, and the only thing it can do with them is buy VERDEX. An executor
///         on the list sweeps a balance of USDG or ETH into VERDEX through an allowlisted router, and the
///         contract checks the VERDEX it got against a floor it computes itself from the pools: USDG to ETH
///         from the Uniswap v3 pool, ETH to VERDEX from the Uniswap v4 pool, less a slippage band. Of every
///         sweep, a fixed share goes to the burn address and the rest waits here for the weekly payout to the
///         wallets that paid the fees. There is no function that sends funds anywhere else: not to the owner,
///         not to the executor. The owner keeps the lists, the split and the band.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory);
    function observations(uint256 index) external view returns (uint32 blockTimestamp, int56 tickCumulative, uint160, bool initialized);
}

interface IPoolManager {
    function extsload(bytes32 slot) external view returns (bytes32);
}

contract VerdexTreasury {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 private constant POOLS_SLOT = bytes32(uint256(6)); // PoolManager._pools
    uint32 public constant TWAP_WINDOW = 1800; // 30-minute TWAP bound against single-block spot depression

    address public immutable verdex;
    address public immutable usdg;
    address public immutable weth;
    IUniswapV3Pool public immutable usdgEthPool; // USDG/WETH on Uniswap v3, for the USDG leg of the floor
    IPoolManager public immutable poolManager; // Uniswap v4, where VERDEX trades against ETH
    bytes32 public immutable verdexPoolId;

    address public owner;
    mapping(address => bool) public isExecutor;
    mapping(address => bool) public isRouter;
    uint16 public burnBps = 5_000;
    uint16 public maxSlippageBps = 800;
    uint256 public rewardsAvailable; // VERDEX bought and not yet paid back
    uint256 public totalBought;
    uint256 public totalBurned;
    uint256 public totalPaidBack;
    uint256 public epoch;
    bool private _locked;

    event Swept(address indexed executor, address indexed tokenIn, uint256 amountIn, uint256 verdexOut, uint256 burned, uint256 kept);
    event Distributed(uint256 indexed epoch, uint256 total, uint256 recipients);
    event ExecutorSet(address indexed executor, bool allowed);
    event RouterSet(address indexed router, bool allowed);
    event SplitSet(uint16 burnBps);
    event SlippageSet(uint16 maxSlippageBps);
    event OwnershipTransferred(address indexed from, address indexed to);

    error Reentrancy();
    error NotOwner();
    error NotExecutor();
    error NotRouter();
    error BadToken();
    error BadArgs();
    error RouteFailed();
    error Short();
    error TooMuch();

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

    constructor(address verdex_, address usdg_, address weth_, IUniswapV3Pool usdgEthPool_, IPoolManager poolManager_, bytes32 verdexPoolId_, address executor_, address router_) {
        verdex = verdex_;
        usdg = usdg_;
        weth = weth_;
        usdgEthPool = usdgEthPool_;
        poolManager = poolManager_;
        verdexPoolId = verdexPoolId_;
        owner = msg.sender;
        if (executor_ != address(0)) { isExecutor[executor_] = true; emit ExecutorSet(executor_, true); }
        if (router_ != address(0)) { isRouter[router_] = true; emit RouterSet(router_, true); }
    }

    receive() external payable {}

    // ----- The floor, from the pools -----

    /// @notice VERDEX for `weiIn` of ETH at the v4 pool's spot price (ETH is currency0, VERDEX currency1).
    function spotVerdexForEth(uint256 weiIn) public view returns (uint256 out) {
        bytes32 slot = keccak256(abi.encodePacked(verdexPoolId, POOLS_SLOT));
        uint256 sqrtP = uint256(poolManager.extsload(slot)) & ((1 << 160) - 1);
        if (sqrtP == 0) revert Short();
        // price of currency1 in currency0 is sqrtP^2 / 2^192, in two steps so nothing overflows
        out = (weiIn * sqrtP) >> 96;
        out = (out * sqrtP) >> 96;
    }

    /// @notice ETH for `amountIn` of USDG at the higher of the v3 pool's spot price and its 30-minute TWAP
    ///         (when available), so a single-block flash-loan dump cannot depress the sweep floor.
    function spotEthForUsdg(uint256 amountIn) public view returns (uint256 out) {
        (uint160 spot,, uint16 index, uint16 cardinality,,,) = usdgEthPool.slot0();
        if (spot == 0) revert Short();
        bool usdgIs0 = usdgEthPool.token0() == usdg;
        out = _ethForUsdgAt(amountIn, spot, usdgIs0);
        uint160 twap = _twapSqrtPrice(index, cardinality);
        if (twap != 0) {
            uint256 twapOut = _ethForUsdgAt(amountIn, twap, usdgIs0);
            if (twapOut > out) out = twapOut;
        }
    }

    function _ethForUsdgAt(uint256 amountIn, uint160 sqrtP, bool usdgIs0) private pure returns (uint256 out) {
        if (usdgIs0) { out = (amountIn * sqrtP) >> 96; out = (out * sqrtP) >> 96; }
        else { out = (amountIn << 96) / sqrtP; out = (out << 96) / sqrtP; }
    }

    function _twapSqrtPrice(uint16 index, uint16 cardinality) private view returns (uint160) {
        if (cardinality < 2) return 0;
        (uint32 oldest,,, bool initialized) = usdgEthPool.observations((uint256(index) + 1) % cardinality);
        if (!initialized) (oldest,,,) = usdgEthPool.observations(0);
        if (block.timestamp <= oldest) return 0;
        uint256 age = block.timestamp - oldest;
        if (age < TWAP_WINDOW / 2) return 0;
        uint32 window = age < TWAP_WINDOW ? uint32(age) : TWAP_WINDOW;
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        ago[1] = 0;
        try usdgEthPool.observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            int24 tick = int24(delta / int56(uint56(window)));
            if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
            return _sqrtAtTick(tick);
        } catch {
            return 0;
        }
    }

    /// @notice VERDEX a sweep of `amountIn` of `tokenIn` would get at spot, before the slippage band.
    function quoteVerdex(address tokenIn, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == address(0) || tokenIn == weth) return spotVerdexForEth(amountIn);
        if (tokenIn == usdg) return spotVerdexForEth(spotEthForUsdg(amountIn));
        revert BadToken();
    }

    /// @notice The least VERDEX a sweep must return: spot less the band.
    function floorOut(address tokenIn, uint256 amountIn) public view returns (uint256) {
        return (quoteVerdex(tokenIn, amountIn) * (10_000 - maxSlippageBps)) / 10_000;
    }

    // ----- Sweep and distribute -----

    /// @notice Swaps `amountIn` of `tokenIn` held here into VERDEX through `router` with the given calldata,
    ///         keeps the result here, burns `burnBps` of it and books the rest for the next payout.
    function sweep(address tokenIn, uint256 amountIn, address router, address spender, bytes calldata data, uint256 minOut) external nonReentrant returns (uint256 out) {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        if (!isRouter[router] || router == verdex || spender == verdex) revert NotRouter();
        if (amountIn == 0) revert BadArgs();
        uint256 floor = floorOut(tokenIn, amountIn);
        uint256 before = IERC20(verdex).balanceOf(address(this));
        uint256 spent;
        if (tokenIn == address(0)) {
            uint256 ethBefore = address(this).balance;
            if (ethBefore < amountIn) revert BadArgs();
            (bool ok,) = router.call{value: amountIn}(data);
            if (!ok) revert RouteFailed();
            uint256 ethAfter = address(this).balance;
            spent = ethBefore > ethAfter ? ethBefore - ethAfter : 0;
        } else {
            uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
            if (inBefore < amountIn) revert BadArgs();
            _approve(tokenIn, spender, amountIn);
            (bool ok,) = router.call(data);
            if (!ok) revert RouteFailed();
            _approve(tokenIn, spender, 0);
            uint256 inAfter = IERC20(tokenIn).balanceOf(address(this));
            spent = inBefore > inAfter ? inBefore - inAfter : 0;
        }
        if (spent == 0 || spent > amountIn) revert Short();
        uint256 afterBal = IERC20(verdex).balanceOf(address(this));
        if (afterBal <= before) revert Short();
        out = afterBal - before;
        if (out < minOut || out < floor) revert Short();
        uint256 burned = (out * burnBps) / 10_000;
        if (burned != 0) require(IERC20(verdex).transfer(DEAD, burned), "burn");
        uint256 kept = out - burned;
        rewardsAvailable += kept;
        totalBought += out;
        totalBurned += burned;
        emit Swept(msg.sender, tokenIn, spent, out, burned, kept);
    }

    /// @notice Pays VERDEX from the rewards bucket to the wallets that paid fees, in the amounts the executor
    ///         computed from the fee events of the period. Never more than the bucket holds.
    function distribute(address[] calldata to, uint256[] calldata amounts) external nonReentrant {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        if (to.length != amounts.length || to.length == 0) revert BadArgs();
        uint256 total;
        for (uint256 i = 0; i < to.length; i++) {
            address recipient = to[i];
            if (recipient == address(0) || recipient == address(this) || recipient == owner || isExecutor[recipient]) revert BadArgs();
            total += amounts[i];
        }
        if (total == 0) revert BadArgs();
        if (total > rewardsAvailable) revert TooMuch();
        rewardsAvailable -= total;
        totalPaidBack += total;
        for (uint256 i = 0; i < to.length; i++) if (amounts[i] != 0) require(IERC20(verdex).transfer(to[i], amounts[i]), "pay");
        epoch += 1;
        emit Distributed(epoch, total, to.length);
    }

    // ----- Owner: the lists, the split, the band -----

    function setExecutor(address executor, bool allowed) external onlyOwner {
        isExecutor[executor] = allowed;
        emit ExecutorSet(executor, allowed);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        isRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function setSplit(uint16 burnBps_) external onlyOwner {
        if (burnBps_ > 10_000) revert BadArgs();
        burnBps = burnBps_;
        emit SplitSet(burnBps_);
    }

    function setMaxSlippage(uint16 bps) external onlyOwner {
        if (bps > 3_000) revert BadArgs();
        maxSlippageBps = bps;
        emit SlippageSet(bps);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert BadArgs();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve");
    }

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

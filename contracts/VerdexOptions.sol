// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  VerdexOptions
/// @notice Calls and puts on tokenized stocks, fully collateralized and settled onchain by delivery. A writer locks
///         what the option could ever need (the stock for a call, the strike in USDG for a put) and names a premium.
///         A buyer pays the premium straight to the writer and holds the option. Until expiry the holder may exercise:
///         a call pays the strike and receives the stock, a put delivers the stock and receives the strike. After
///         expiry an unexercised option's collateral goes back to the writer. Holders can pass an option on.
///         There is no price oracle: an option is only ever exercised by its holder, at its strike.
/// @dev    Holds the writers' collateral and nothing else. No owner, no admin, no fee. Unaudited.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract VerdexOptions {
    struct Option {
        address writer;
        address holder; // address(0) while it is for sale
        address underlying;
        bool isPut;
        uint8 state; // 0 open (for sale or held), 1 exercised, 2 collateral back to the writer
        uint40 expiresAt;
        uint256 amount; // underlying units the option covers
        uint256 strike; // USDG for the whole amount
        uint256 premium; // USDG the buyer pays the writer
    }

    IERC20 public immutable usdg;
    Option[] internal _options;
    mapping(address => uint256[]) internal _written;
    mapping(address => uint256[]) internal _held;
    uint256 private _lock = 1;

    uint256 public constant MIN_LIFE = 1 hours;
    uint256 public constant MAX_LIFE = 365 days;

    event Written(uint256 indexed id, address indexed writer, address indexed underlying, bool isPut, uint256 amount, uint256 strike, uint256 premium, uint40 expiresAt);
    event Bought(uint256 indexed id, address indexed buyer, uint256 premium);
    event Transferred(uint256 indexed id, address indexed from, address indexed to);
    event Exercised(uint256 indexed id, address indexed holder);
    event Reclaimed(uint256 indexed id);

    error BadArgs();
    error NotForSale();
    error NotHolder();
    error NotWriter();
    error Expired();
    error NotExpired();
    error NotOpen();
    error TransferFailed();
    error Locked();

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    /// @notice Write an option for sale. A call locks `amount` of `underlying`; a put locks `strike` USDG.
    function write(address underlying, bool isPut, uint256 amount, uint256 strike, uint256 premium, uint40 expiresAt) external nonReentrant returns (uint256 id) {
        if (underlying.code.length == 0 || underlying == address(usdg) || amount == 0 || strike == 0) revert BadArgs();
        if (expiresAt < block.timestamp + MIN_LIFE || expiresAt > block.timestamp + MAX_LIFE) revert BadArgs();
        if (isPut) {
            if (_pullIn(usdg, msg.sender, strike) != strike) revert TransferFailed();
        } else {
            if (_pullIn(IERC20(underlying), msg.sender, amount) != amount) revert TransferFailed();
        }
        id = _options.length;
        _options.push(Option(msg.sender, address(0), underlying, isPut, 0, expiresAt, amount, strike, premium));
        _written[msg.sender].push(id);
        emit Written(id, msg.sender, underlying, isPut, amount, strike, premium, expiresAt);
    }

    /// @notice Buy option `id`: the premium goes to the writer, the option to you.
    function buy(uint256 id) external nonReentrant {
        Option storage o = _get(id);
        if (o.holder != address(0) || o.state != 0) revert NotForSale();
        if (block.timestamp >= o.expiresAt) revert Expired();
        if (msg.sender == o.writer) revert BadArgs();
        o.holder = msg.sender;
        _held[msg.sender].push(id);
        if (o.premium != 0) _pull(usdg, msg.sender, o.writer, o.premium);
        emit Bought(id, msg.sender, o.premium);
    }

    /// @notice Pass a held option on to `to`.
    function transfer(uint256 id, address to) external {
        Option storage o = _get(id);
        if (msg.sender != o.holder || o.state != 0) revert NotHolder();
        if (to == address(0) || to == msg.sender) revert BadArgs();
        uint256[] storage fromHeld = _held[msg.sender];
        for (uint256 i = 0; i < fromHeld.length; i++) {
            if (fromHeld[i] == id) {
                fromHeld[i] = fromHeld[fromHeld.length - 1];
                fromHeld.pop();
                break;
            }
        }
        o.holder = to;
        _held[to].push(id);
        emit Transferred(id, msg.sender, to);
    }

    /// @notice Exercise before expiry. Call: pay the strike, receive the stock. Put: deliver the stock, receive the strike.
    function exercise(uint256 id) external nonReentrant {
        Option storage o = _get(id);
        if (msg.sender != o.holder || o.state != 0) revert NotHolder();
        if (block.timestamp >= o.expiresAt) revert Expired();
        o.state = 1;
        if (o.isPut) {
            uint256 before = IERC20(o.underlying).balanceOf(o.writer);
            _pull(IERC20(o.underlying), msg.sender, o.writer, o.amount);
            if (IERC20(o.underlying).balanceOf(o.writer) - before != o.amount) revert TransferFailed();
            _push(usdg, msg.sender, o.strike);
        } else {
            uint256 before = usdg.balanceOf(o.writer);
            _pull(usdg, msg.sender, o.writer, o.strike);
            if (usdg.balanceOf(o.writer) - before != o.strike) revert TransferFailed();
            _push(IERC20(o.underlying), msg.sender, o.amount);
        }
        emit Exercised(id, msg.sender);
    }

    /// @notice The writer takes the collateral back: any time while nobody has bought it, or after expiry.
    function reclaim(uint256 id) external nonReentrant {
        Option storage o = _get(id);
        if (msg.sender != o.writer) revert NotWriter();
        if (o.state != 0) revert NotOpen();
        if (o.holder != address(0) && block.timestamp < o.expiresAt) revert NotExpired();
        o.state = 2;
        if (o.isPut) _push(usdg, o.writer, o.strike);
        else _push(IERC20(o.underlying), o.writer, o.amount);
        emit Reclaimed(id);
    }

    function option(uint256 id) external view returns (Option memory) { return _options[id]; }
    function optionCount() external view returns (uint256) { return _options.length; }
    function writtenBy(address who) external view returns (uint256[] memory) { return _written[who]; }
    function heldBy(address who) external view returns (uint256[] memory) { return _held[who]; }

    function _get(uint256 id) private view returns (Option storage) {
        if (id >= _options.length) revert BadArgs();
        return _options[id];
    }

    function _pullIn(IERC20 t, address from, uint256 amount) private returns (uint256) {
        uint256 before = t.balanceOf(address(this));
        _pull(t, from, address(this), amount);
        return t.balanceOf(address(this)) - before;
    }

    function _pull(IERC20 t, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(t).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(IERC20 t, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(t).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

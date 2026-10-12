// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  VerdexGift
/// @notice Gift a token through a link. The sender deposits an amount of any ERC-20 (a tokenized stock, USDG) under a
///         one-time public key; the link carries the matching private key, never the server. To claim, the key signs
///         the receiver's address, so a claim copied from the mempool can only ever pay that same receiver. Anyone may
///         submit the signed claim, which lets a relayer pay the gas for a receiver who has none. After the expiry the
///         sender, and only the sender, can take an unclaimed gift back.
/// @dev    Holds the deposited gifts and nothing else. No owner, no admin, no fee. Unaudited.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract VerdexGift {
    struct Gift {
        address sender;
        address token;
        address key; // the address of the one-time key in the link
        uint40 createdAt;
        uint40 expiresAt; // after this the sender can take it back
        uint8 state; // 0 waiting, 1 claimed, 2 taken back
        uint256 amount;
        address claimedBy;
    }

    Gift[] internal _gifts;
    mapping(address => uint256[]) internal _sent;
    mapping(address => uint256) public idOfKey; // id + 1, so a key is used once
    uint256 private _lock = 1;

    uint256 public constant MIN_LIFE = 1 hours;
    uint256 public constant MAX_LIFE = 365 days;

    event Created(uint256 indexed id, address indexed sender, address indexed token, uint256 amount, address key, uint40 expiresAt);
    event Claimed(uint256 indexed id, address indexed to, address relayer);
    event TakenBack(uint256 indexed id, address indexed sender);

    error BadGift();
    error KeyUsed();
    error NotWaiting();
    error BadSignature();
    error NotSender();
    error NotExpired();
    error TransferFailed();
    error Locked();

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Deposit `amount` of `token` as a gift claimable with the private key of `key`, until `expiresAt`.
    function create(address token, uint256 amount, address key, uint40 expiresAt) external nonReentrant returns (uint256 id) {
        if (token.code.length == 0 || amount == 0 || key == address(0)) revert BadGift();
        if (expiresAt < block.timestamp + MIN_LIFE || expiresAt > block.timestamp + MAX_LIFE) revert BadGift();
        if (idOfKey[key] != 0) revert KeyUsed();
        uint256 before = IERC20(token).balanceOf(address(this));
        _pull(token, msg.sender, amount);
        uint256 got = IERC20(token).balanceOf(address(this)) - before;
        if (got == 0) revert BadGift();
        id = _gifts.length;
        _gifts.push(Gift({ sender: msg.sender, token: token, key: key, createdAt: uint40(block.timestamp), expiresAt: expiresAt, state: 0, amount: got, claimedBy: address(0) }));
        _sent[msg.sender].push(id);
        idOfKey[key] = id + 1;
        emit Created(id, msg.sender, token, got, key, expiresAt);
    }

    /// @notice What the link's key signs to claim gift `id` to `to` (an EIP-191 personal message over this digest).
    function claimDigest(uint256 id, address to) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, id, to));
    }

    /// @notice Claim gift `id` to `to` with the key's signature. Anyone may submit it; the gift only ever goes to `to`.
    function claim(uint256 id, address to, bytes calldata signature) external nonReentrant {
        if (id >= _gifts.length || to == address(0)) revert BadGift();
        Gift storage g = _gifts[id];
        if (g.state != 0) revert NotWaiting();
        if (_signer(claimDigest(id, to), signature) != g.key) revert BadSignature();
        g.state = 1;
        g.claimedBy = to;
        _push(g.token, to, g.amount);
        emit Claimed(id, to, msg.sender);
    }

    /// @notice After the expiry, the sender takes an unclaimed gift back.
    function takeBack(uint256 id) external nonReentrant {
        if (id >= _gifts.length) revert BadGift();
        Gift storage g = _gifts[id];
        if (msg.sender != g.sender) revert NotSender();
        if (g.state != 0) revert NotWaiting();
        if (block.timestamp < g.expiresAt) revert NotExpired();
        g.state = 2;
        _push(g.token, g.sender, g.amount);
        emit TakenBack(id, g.sender);
    }

    function gift(uint256 id) external view returns (Gift memory) {
        return _gifts[id];
    }

    function giftCount() external view returns (uint256) {
        return _gifts.length;
    }

    function sentBy(address sender) external view returns (uint256[] memory) {
        return _sent[sender];
    }

    function _signer(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // Reject malleable signatures (s in the upper half of the curve order).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(h, v, r, s);
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

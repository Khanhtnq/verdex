// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  VerdexTerm
/// @notice Term loans between two people, with any token as collateral: every tokenized stock, VERDEX, anything.
///         A lender posts an offer (lend up to this much USDG against this token, this much collateral per USDG,
///         this fixed interest, for this long), or a borrower posts a request with the collateral already locked.
///         The other side takes it and the loan starts. The borrower repays principal plus the fixed interest any
///         time before the end and takes the collateral back. If the loan is not repaid by the end, the lender takes
///         the collateral. There is no price oracle and no liquidation before the end: the terms are the terms.
/// @dev    Holds open offers, open requests and live loans. No owner, no admin, no fee. Unaudited.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract VerdexTerm {
    struct Offer {
        address maker; // the lender (offer) or the borrower (request)
        bool isRequest; // false: USDG is locked, waiting for borrowers; true: collateral is locked, waiting for a lender
        bool closed;
        address collateral;
        uint256 left; // offer: USDG still lendable. request: collateral still locked
        uint256 collPerLoan; // collateral units required per 1e18 units of the loan token
        uint256 minLoan; // smallest loan a taker may take, in loan units
        uint16 interestBps; // fixed interest for the whole term, on the principal
        uint32 term; // seconds
        uint40 expiresAt; // after this nobody can take it
    }
    struct Loan {
        uint256 offerId;
        address lender;
        address borrower;
        address collateral;
        uint256 principal;
        uint256 owed; // principal plus the fixed interest
        uint256 collAmount;
        uint40 startAt;
        uint40 endAt;
        uint8 state; // 0 live, 1 repaid, 2 collateral claimed by the lender
    }

    IERC20 public immutable loanToken;
    Offer[] internal _offers;
    Loan[] internal _loans;
    mapping(address => uint256[]) internal _offersOf;
    mapping(address => uint256[]) internal _loansOf;
    uint256 private _lock = 1;

    uint32 public constant MIN_TERM = 1 days;
    uint32 public constant MAX_TERM = 365 days;
    uint16 public constant MAX_INTEREST_BPS = 5000;

    event Posted(uint256 indexed id, address indexed maker, address indexed collateral, bool isRequest, uint256 amount, uint256 collPerLoan, uint16 interestBps, uint32 term);
    event Closed(uint256 indexed id, uint256 returned);
    event Started(uint256 indexed loanId, uint256 indexed offerId, address indexed borrower, address lender, uint256 principal, uint256 owed, uint256 collAmount, uint40 endAt);
    event Repaid(uint256 indexed loanId, address payer);
    event Claimed(uint256 indexed loanId);

    error BadArgs();
    error NotMaker();
    error NotOpen();
    error NotLive();
    error NotLender();
    error TooEarly();
    error TooLate();
    error TransferFailed();
    error Locked();

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20 loanToken_) {
        loanToken = loanToken_;
    }

    /// @notice Lend: lock `amount` USDG; borrowers may take loans from it against `collateral`.
    function postOffer(address collateral, uint256 amount, uint256 collPerLoan, uint256 minLoan, uint16 interestBps, uint32 term, uint40 expiresAt) external nonReentrant returns (uint256 id) {
        _check(collateral, collPerLoan, interestBps, term, expiresAt);
        if (amount == 0 || minLoan > amount) revert BadArgs();
        uint256 got = _pullIn(loanToken, msg.sender, amount);
        id = _post(Offer(msg.sender, false, false, collateral, got, collPerLoan, minLoan, interestBps, term, expiresAt));
    }

    /// @notice Borrow: lock `collAmount` of `collateral`; a lender may fund it at `collPerLoan` collateral per USDG.
    function postRequest(address collateral, uint256 collAmount, uint256 collPerLoan, uint256 minLoan, uint16 interestBps, uint32 term, uint40 expiresAt) external nonReentrant returns (uint256 id) {
        _check(collateral, collPerLoan, interestBps, term, expiresAt);
        if (collAmount == 0) revert BadArgs();
        uint256 got = _pullIn(IERC20(collateral), msg.sender, collAmount);
        id = _post(Offer(msg.sender, true, false, collateral, got, collPerLoan, minLoan, interestBps, term, expiresAt));
    }

    /// @notice Take `principal` USDG from offer `id`: lock the collateral it asks for, receive the USDG now.
    function borrow(uint256 id, uint256 principal) external nonReentrant returns (uint256 loanId) {
        Offer storage o = _open(id, false);
        if (principal == 0 || principal > o.left || (principal < o.minLoan && principal != o.left)) revert BadArgs();
        uint256 coll = _collFor(principal, o.collPerLoan);
        o.left -= principal;
        uint256 got = _pullIn(IERC20(o.collateral), msg.sender, coll);
        if (got < coll) revert TransferFailed();
        loanId = _start(id, o, o.maker, msg.sender, principal, coll);
        _push(loanToken, msg.sender, principal);
    }

    /// @notice Fund request `id` with `principal` USDG: it goes to the borrower now, against their locked collateral.
    function lend(uint256 id, uint256 principal) external nonReentrant returns (uint256 loanId) {
        Offer storage o = _open(id, true);
        uint256 coll = _collFor(principal, o.collPerLoan);
        if (principal == 0 || coll > o.left || (principal < o.minLoan && coll != o.left)) revert BadArgs();
        o.left -= coll;
        _pull(loanToken, msg.sender, o.maker, principal);
        loanId = _start(id, o, msg.sender, o.maker, principal, coll);
    }

    /// @notice Repay loan `loanId` in full (anyone may pay it for the borrower); the collateral goes back to the borrower.
    function repay(uint256 loanId) external nonReentrant {
        Loan storage l = _loans[loanId];
        if (l.state != 0) revert NotLive();
        if (block.timestamp > l.endAt) revert TooLate();
        l.state = 1;
        _pull(loanToken, msg.sender, l.lender, l.owed);
        _push(IERC20(l.collateral), l.borrower, l.collAmount);
        emit Repaid(loanId, msg.sender);
    }

    /// @notice After the end, an unpaid loan's collateral goes to the lender.
    function claim(uint256 loanId) external nonReentrant {
        Loan storage l = _loans[loanId];
        if (l.state != 0) revert NotLive();
        if (msg.sender != l.lender) revert NotLender();
        if (block.timestamp <= l.endAt) revert TooEarly();
        l.state = 2;
        _push(IERC20(l.collateral), l.lender, l.collAmount);
        emit Claimed(loanId);
    }

    /// @notice Close an offer or request and take back what is still unused. Live loans are not affected.
    function close(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (msg.sender != o.maker) revert NotMaker();
        if (o.closed) revert NotOpen();
        o.closed = true;
        uint256 back = o.left;
        o.left = 0;
        if (back != 0) _push(o.isRequest ? IERC20(o.collateral) : loanToken, o.maker, back);
        emit Closed(id, back);
    }

    function collFor(uint256 id, uint256 principal) external view returns (uint256) { return _collFor(principal, _offers[id].collPerLoan); }
    function offer(uint256 id) external view returns (Offer memory) { return _offers[id]; }
    function loan(uint256 id) external view returns (Loan memory) { return _loans[id]; }
    function offerCount() external view returns (uint256) { return _offers.length; }
    function loanCount() external view returns (uint256) { return _loans.length; }
    function offersOf(address who) external view returns (uint256[] memory) { return _offersOf[who]; }
    function loansOf(address who) external view returns (uint256[] memory) { return _loansOf[who]; }

    function _check(address collateral, uint256 collPerLoan, uint16 interestBps, uint32 term, uint40 expiresAt) private view {
        if (collateral.code.length == 0 || collateral == address(loanToken) || collPerLoan == 0) revert BadArgs();
        if (interestBps > MAX_INTEREST_BPS || term < MIN_TERM || term > MAX_TERM || expiresAt <= block.timestamp) revert BadArgs();
    }

    function _post(Offer memory o) private returns (uint256 id) {
        id = _offers.length;
        _offers.push(o);
        _offersOf[o.maker].push(id);
        emit Posted(id, o.maker, o.collateral, o.isRequest, o.left, o.collPerLoan, o.interestBps, o.term);
    }

    function _open(uint256 id, bool isRequest) private view returns (Offer storage o) {
        if (id >= _offers.length) revert BadArgs();
        o = _offers[id];
        if (o.closed || o.isRequest != isRequest || block.timestamp > o.expiresAt || msg.sender == o.maker) revert NotOpen();
    }

    function _start(uint256 offerId, Offer storage o, address lender, address borrower, uint256 principal, uint256 coll) private returns (uint256 loanId) {
        uint256 owed = principal + _mulDivUp(principal, o.interestBps, 10_000);
        uint40 endAt = uint40(block.timestamp) + o.term;
        loanId = _loans.length;
        _loans.push(Loan(offerId, lender, borrower, o.collateral, principal, owed, coll, uint40(block.timestamp), endAt, 0));
        _loansOf[lender].push(loanId);
        _loansOf[borrower].push(loanId);
        emit Started(loanId, offerId, borrower, lender, principal, owed, coll, endAt);
    }

    function _collFor(uint256 principal, uint256 collPerLoan) private pure returns (uint256) { return _mulDivUp(principal, collPerLoan, 1e18); }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) private pure returns (uint256) { return a == 0 ? 0 : (a * b - 1) / d + 1; }

    /// Pulls into this contract and returns what actually arrived (fee-on-transfer tokens lock what they deliver).
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

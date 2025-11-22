;; Streamflow Liquidity Protocol
;; A time-based streaming payouts app backed by LP liquidity.

(define-constant ERR_UNAUTHORIZED (err u100))
(define-constant ERR_NO_STREAM (err u101))
(define-constant ERR_INVALID_PARAMS (err u102))
(define-constant ERR_INSUFFICIENT_LIQUIDITY (err u103))
(define-constant ERR_NOTHING_TO_CLAIM (err u104))
(define-constant ERR_ALREADY_CANCELLED (err u105))

(define-data-var next-stream-id uint u0)

;; Liquidity provided in STX and held by the contract.
(define-map liquidity-providers
  { provider: principal }
  { balance: uint })

;; Streams pay out STX linearly from start-block to end-block.
(define-map streams
  { id: uint }
  {
    owner: principal,
    recipient: principal,
    deposit: uint,
    start-block: uint,
    end-block: uint,
    withdrawn: uint,
    cancelled: bool
  })

;; Internal helper: read liquidity balance
(define-read-only (get-liquidity-internal (who principal))
  (default-to u0
    (get balance (map-get? liquidity-providers { provider: who }))))

;; Public read-only: get liquidity balance for a provider
(define-read-only (get-liquidity (who principal))
  (ok (get-liquidity-internal who)))

;; Public read-only: get raw stream data
(define-read-only (get-stream (stream-id uint))
  (match (map-get? streams { id: stream-id })
    stream (ok stream)
    (err u101)))

;; Internal: compute how much of a stream has vested at the current block-height.
(define-read-only (get-vested-amount (deposit uint) (start-block uint) (end-block uint) (current-height uint))
  (if (<= current-height start-block)
      u0
      (let
        (
          (effective-end (if (> current-height end-block) end-block current-height))
          (duration (- end-block start-block))
        )
        (if (is-eq duration u0)
            deposit
            (/ (* deposit (- effective-end start-block)) duration)))))

;; Public read-only: how much can be claimed from a stream right now.
(define-read-only (get-claimable (stream-id uint))
  (match (map-get? streams { id: stream-id })
    stream
      (let
        (
          (deposit (get deposit stream))
          (start (get start-block stream))
          (end (get end-block stream))
          (withdrawn (get withdrawn stream))
          (vested (get-vested-amount deposit start end block-height))
          (claimable (if (> vested withdrawn) (- vested withdrawn) u0))
        )
        (ok claimable))
    (err u101)))

;; Liquidity: deposit STX into the protocol (accounting only).
(define-public (deposit-liquidity (amount uint))
  (if (or (is-eq amount u0) (< amount u1))
      ERR_INVALID_PARAMS
      (let
        ((current (get-liquidity-internal tx-sender))
         (new-balance (+ current amount)))
        (begin
          (map-set liquidity-providers { provider: tx-sender } { balance: new-balance })
          (ok new-balance)))))

;; Liquidity: withdraw STX from the protocol (accounting only).
(define-public (withdraw-liquidity (amount uint))
  (let
    ((current (get-liquidity-internal tx-sender)))
    (if (or (is-eq amount u0) (> amount current))
        ERR_INSUFFICIENT_LIQUIDITY
        (let
          ((new-balance (- current amount)))
          (begin
            (map-set liquidity-providers { provider: tx-sender } { balance: new-balance })
            (ok new-balance))))))

;; Create a new STX stream backed by caller's liquidity.
;; - `deposit-amount` is locked immediately from the caller's liquidity.
;; - `duration` is in blocks.
(define-public (create-stream (recipient principal) (deposit-amount uint) (duration uint))
  (let
    ((current-liquidity (get-liquidity-internal tx-sender)))
    (if (or (is-eq recipient tx-sender)
            (is-eq deposit-amount u0)
            (is-eq duration u0)
            (> deposit-amount current-liquidity))
        (if (> deposit-amount current-liquidity)
            ERR_INSUFFICIENT_LIQUIDITY
            ERR_INVALID_PARAMS)
        (let
          ((stream-id (var-get next-stream-id))
           (start block-height)
           (end (+ block-height duration)))
          (begin
            (map-set liquidity-providers { provider: tx-sender }
              { balance: (- current-liquidity deposit-amount) })
            (map-set streams { id: stream-id }
              {
                owner: tx-sender,
                recipient: recipient,
                deposit: deposit-amount,
                start-block: start,
                end-block: end,
                withdrawn: u0,
                cancelled: false
              })
            (var-set next-stream-id (+ stream-id u1))
            (ok stream-id))))))

;; Recipient withdraws vested STX from a stream.
(define-public (withdraw-from-stream (stream-id uint))
  (match (map-get? streams { id: stream-id })
    stream
      (if (or (get cancelled stream)
              (not (is-eq tx-sender (get recipient stream))))
          ERR_UNAUTHORIZED
          (let
            (
              (deposit (get deposit stream))
              (start (get start-block stream))
              (end (get end-block stream))
              (already-withdrawn (get withdrawn stream))
              (vested (get-vested-amount deposit start end block-height))
              (claimable (if (> vested already-withdrawn) (- vested already-withdrawn) u0))
            )
            (if (is-eq claimable u0)
                ERR_NOTHING_TO_CLAIM
                (begin
                  ;; Accounting: mark the vested amount as withdrawn.
                  (map-set streams { id: stream-id }
                    (merge stream { withdrawn: (+ already-withdrawn claimable) }))
                  (ok claimable)))))
    (err u101)))

;; Owner can cancel a stream, reclaiming unvested funds as liquidity while
;; forcing the remaining vested (but unclaimed) amount to be paid out.
(define-public (cancel-stream (stream-id uint))
  (match (map-get? streams { id: stream-id })
    stream
      (if (not (is-eq tx-sender (get owner stream)))
          ERR_UNAUTHORIZED
          (if (get cancelled stream)
              ERR_ALREADY_CANCELLED
              (let
                (
                  (deposit (get deposit stream))
                  (start (get start-block stream))
                  (end (get end-block stream))
                  (already-withdrawn (get withdrawn stream))
                  (vested (get-vested-amount deposit start end block-height))
                  (claimable (if (> vested already-withdrawn) (- vested already-withdrawn) u0))
                  (unvested (if (> deposit vested) (- deposit vested) u0))
                  (owner (get owner stream))
                  (recipient (get recipient stream))
                  (current-liquidity (get-liquidity-internal owner))
                )
                (begin
                  ;; Accounting: vested portion is considered paid; unvested is
                  ;; returned to the owner's liquidity.
                  ;; unvested portion becomes available liquidity again
                  (map-set liquidity-providers { provider: owner }
                    { balance: (+ current-liquidity unvested) })
                  (map-set streams { id: stream-id }
                    (merge stream { cancelled: true, withdrawn: vested }))
                  (ok {
                    claimable-paid: claimable,
                    unvested-returned: unvested
                  })))))
    (err u101)))

# Streamflow Liquidity: A Documentary of a Streaming LP Protocol

## 1. The Idea: Liquidity That Tells Time

Traditional DeFi liquidity is static: LPs deposit tokens and wait for fees. In Streamflow Liquidity, we ask a different question:

> What if liquidity could tell time?

Instead of sending one-off payments, LPs deposit STX into a protocol that can carve out *streams* – time-based payouts that unlock gradually over blocks. Every stream is a story: who funded it, who receives it, how fast value flows, and when it stops.

The goal of this project is to build a minimal but complete ecosystem around that idea:

- A Clarity contract that manages pooled STX liquidity and time-based payment streams
- A set of Clarinet/Vitest tests that exercise the key behaviors
- A UI (first-pass and then redesigned) that connects to these on-chain flows

This document walks through that journey.

---

## 2. Architecture at a Glance

### On-chain components

**Contract:** `contracts/streamflow-liquidity.clar`

Core responsibilities:

1. **Liquidity accounting**
   - Track how much STX each provider has contributed.
   - Ensure only available liquidity can be used to fund streams.

2. **Streaming engine**
   - Model a stream as a linear vesting schedule from `start-block` to `end-block`.
   - Allow the recipient to withdraw vested STX over time.
   - Allow the owner to cancel, reclaiming unvested funds while paying out anything already vested.

3. **Read-only analytics**
   - Query a provider’s liquidity.
   - Query a stream’s configuration and claimable amount.

### Off-chain components

1. **Clarinet/Vitest tests** (`tests/streamflow-liquidity.test.ts`)
   - Use `vitest-environment-clarinet` to spin up a Simnet.
   - Interact with the contract via public/read-only functions.

2. **UI (planned)**
   - Initial version: a straightforward interface to deposit liquidity, create a stream, withdraw from a stream, and cancel a stream.
   - Redesigned version: improved layout and UX, surfacing stream state clearly and guiding the user through flows.

---

## 3. Clarity Contract Deep Dive

### 3.1 Data structures

At the heart of the protocol are two maps and a counter:

- `liquidity-providers` — maps `{ provider: principal } -> { balance: uint }`
- `streams` — maps `{ id: uint }` to a record:
  - `owner: principal`
  - `recipient: principal`
  - `deposit: uint` (total STX locked for the stream)
  - `start-block: uint`
  - `end-block: uint`
  - `withdrawn: uint` (amount already claimed by recipient)
  - `cancelled: bool`
- `next-stream-id: uint` — monotonically increasing stream identifier.

Error conditions are captured as `err u100`–`u105` constants, e.g. `ERR_UNAUTHORIZED`, `ERR_INSUFFICIENT_LIQUIDITY`, etc.

### 3.2 Liquidity lifecycle

**Deposit liquidity** — `deposit-liquidity (amount uint)`

- The caller transfers `amount` STX to the contract.
- The contract increments that caller’s `liquidity-providers` balance.
- Returns the caller’s updated liquidity balance.

This is the entry point for LPs to supply fuel for future streams.

**Withdraw liquidity** — `withdraw-liquidity (amount uint)`

- Reads the caller’s current liquidity.
- If `amount` is zero or exceeds available liquidity, returns `ERR_INSUFFICIENT_LIQUIDITY`.
- Otherwise:
  - Reduces the provider’s liquidity by `amount`.
  - Sends STX back to the provider.
  - Returns the new liquidity balance.

This creates a dynamic pool — LPs can enter and exit as needed, constrained only by what has been locked into active streams.

### 3.3 Streaming mechanics

**Creating a stream** — `create-stream (recipient principal) (deposit-amount uint) (duration uint)`

Conceptually:

- Validate input:
  - `recipient` cannot be the sender.
  - `deposit-amount` and `duration` must be > 0.
  - The sender must have at least `deposit-amount` liquidity.
- Allocate a new `stream-id` from `next-stream-id`.
- Lock `deposit-amount` from the sender’s liquidity into the stream.
- Record a `streams` entry with:
  - `start-block = block-height`
  - `end-block = block-height + duration`
- Decrement the sender’s liquidity by `deposit-amount`.
- Return the newly created `stream-id`.

This effectively reshapes static liquidity into a time-dependent payment schedule.

**Vesting function** — `get-vested-amount (deposit start-block end-block current-height)`

This is the mathematical heart of the protocol:

- Before `start-block`: nothing is vested.
- After `end-block`: 100% is vested.
- Between them: linearly interpolate based on how many blocks have elapsed.

This function is read-only and reused by both `get-claimable` and the mutate functions.

**Claiming from a stream** — `withdraw-from-stream (stream-id uint)`

- Checks that:
  - The stream exists.
  - The stream is not cancelled.
  - `tx-sender` is the `recipient`.
- Computes how much has vested and how much has already been withdrawn.
- If there’s nothing new to claim, returns `ERR_NOTHING_TO_CLAIM`.
- Otherwise:
  - Transfers the claimable STX to the recipient.
  - Updates the stream’s `withdrawn` amount.
  - Returns the claimed amount.

**Cancelling a stream** — `cancel-stream (stream-id uint)`

- Only the `owner` can cancel; others receive `ERR_UNAUTHORIZED`.
- Cannot cancel twice (`ERR_ALREADY_CANCELLED`).
- On cancel:
  - Compute `vested` and `unvested` portions using the vesting helper.
  - Pay any remaining vested amount to the recipient.
  - Return the unvested amount back into the owner’s `liquidity-providers` balance.
  - Mark the stream as `cancelled = true` and set `withdrawn = vested`.

Cancellation is thus a graceful shut-off valve: it ensures recipients never lose vested funds, while owners can reclaim future value.

### 3.4 Observability

Read-only functions:

- `get-liquidity (who principal)` — returns an ok-wrapped uint liquidity balance.
- `get-stream (stream-id uint)` — returns the full stream struct, or error if missing.
- `get-claimable (stream-id uint)` — computes how much could be withdrawn right now.

These are the contract’s “view layer”, exposing on-chain state to tests and UIs.

---

## 4. Clarinet / Vitest Tests

All tests live in `tests/streamflow-liquidity.test.ts` and run under Vitest with `vitest-environment-clarinet`.

High-level scenarios covered:

1. **Liquidity deposit & balance tracking**
   - A provider deposits STX.
   - The test asserts:
     - The public call returns an ok(uint) with the new balance.
     - `get-liquidity` returns the same value.

2. **Partial liquidity withdrawal**
   - A provider deposits, then withdraws a subset.
   - The test checks:
     - The withdraw call returns an ok(uint) matching the remaining liquidity.
     - `get-liquidity` reflects that reduced balance.

3. **Insufficient liquidity on withdrawal**
   - A provider deposits a small amount and attempts to withdraw more than they have.
   - Expectation:
     - The transaction fails with `ERR_INSUFFICIENT_LIQUIDITY (err u103)`.

4. **Stream creation and liquidity locking**
   - A provider deposits liquidity and creates a stream.
   - Tests validate that:
     - The call returns an ok-wrapped `stream-id`.
     - The provider’s liquidity is reduced by the stream’s deposit.
     - `get-stream` shows the correct `owner`, `recipient`, and `deposit`.

5. **Attempted early withdrawal from a stream**
   - A stream is created with a long duration.
   - The recipient tries to withdraw immediately.
   - Result:
     - The call returns `ERR_NOTHING_TO_CLAIM (err u104)`.

6. **Stream cancellation access control**
   - A valid stream is created.
   - An attacker tries to cancel and receives `ERR_UNAUTHORIZED (err u100)`.
   - The owner successfully cancels once.
   - A second cancellation attempt by the owner returns `ERR_ALREADY_CANCELLED (err u105)`.

These tests double as living documentation, showing how off-chain code should interact with the on-chain primitives.

---

## 5. UI Concept: From Raw Controls to a Stream Storyboard

The UI is envisioned in two iterations:

### 5.1 First iteration: Operator dashboard

The initial UI is an operator-style dashboard with three main panels:

1. **Liquidity panel**
   - Inputs:
     - Amount of STX to deposit
     - Amount of STX to withdraw
   - Actions:
     - "Deposit liquidity" → calls `deposit-liquidity`.
     - "Withdraw liquidity" → calls `withdraw-liquidity`.
   - Displays the connected wallet’s current liquidity from `get-liquidity`.

2. **Stream creation panel**
   - Inputs:
     - Recipient principal
     - Deposit amount to lock into the stream
     - Duration in blocks
   - Action:
     - "Create stream" → calls `create-stream`.
   - Feedback:
     - Shows the new `stream-id` and updated liquidity.

3. **Stream actions panel**
   - Inputs:
     - Stream ID
   - Actions:
     - "Withdraw from stream" → calls `withdraw-from-stream` as the recipient.
     - "Cancel stream" → calls `cancel-stream` as the owner.
   - Metrics:
     - Shows claimable amount from `get-claimable`.

The focus is functionality over polish — a clear mapping from buttons and inputs directly to Clarity function calls.

### 5.2 Redesigned iteration: Narrative view of streams

The redesigned UI aims to improve the experience by:

- **Grouping flows by role**
  - LP/Owner view: manage liquidity, create streams, cancel streams.
  - Recipient view: list incoming streams and claim vested amounts.

- **Visualizing time**
  - For each stream, show a progress bar from `start-block` to `end-block`.
  - Display current claimable STX as a prominent figure, with a one-click "Claim" action.

- **Reducing cognitive load**
  - Wizards for creating a stream:
    1. Choose recipient.
    2. Choose deposit size (with current liquidity shown and validated).
    3. Choose duration (with a human-friendly description like “≈ X minutes / hours / days”).
  - Clear error messages mapped from the error codes:
    - `ERR_INSUFFICIENT_LIQUIDITY` → "You don’t have enough available liquidity to fund this stream."
    - `ERR_INVALID_PARAMS` → "Please check deposit amount and duration. Both must be greater than zero."

This redesign turns the UI from a control panel into a storytelling surface for value streams.

---

## 6. Future Directions

Streamflow Liquidity, as implemented here, is intentionally focused but extensible. Some natural next chapters for this documentary:

1. **Multi-asset support**
   - Generalize from STX to fungible tokens (SIP-010), allowing LPs to back streams in different assets.

2. **Programmable schedules**
   - Allow non-linear vesting: cliffs, step functions, or custom curves.

3. **Composable protocols**
   - Build higher-level protocols on top of streams, such as subscription services or streaming salaries.

4. **Analytics and history**
   - Track historical events (stream created, withdrawn, cancelled) and expose them via events for indexers.

---

## 7. How to Run and Explore

1. **Clarinet tests**
   - Install dependencies in the project root.
   - Run `npm test` to execute the Vitest suite against the Clarinet Simnet.

2. **Contract exploration**
   - Use `clarinet console` or the Clarinet REPL to directly call the public and read-only functions.
   - Experiment with different durations and deposit sizes and observe `get-claimable` over simulated blocks.

3. **UI iterations**
   - Start with a simple set of HTML/JS controls mapped one-to-one to contract calls.
   - Iterate toward the redesigned, narrative-heavy UI described above.

This documentary is meant to serve as a technical narrative: from idea to contract, from tests to user experience, all centered on the simple but powerful notion of liquidity that flows over time.

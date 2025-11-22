// @ts-nocheck
import { describe, it, expect } from "vitest";
import { Cl } from "@stacks/transactions";

/*
  These tests use the `simnet` object provided globally by
  `vitest-environment-clarinet` (see `vitest.config.js`).

  They exercise the core flows of the `streamflow-liquidity` contract:
  - depositing and withdrawing STX liquidity
  - creating streams backed by liquidity
  - attempting to withdraw before anything is vested
  - cancelling streams and validating access control
*/

declare const simnet: any;

describe("streamflow-liquidity :: liquidity management", () => {
  it("allows a provider to deposit liquidity and see their balance", () => {
    // use the deployer account as the initial liquidity provider
    const provider = simnet.deployer;

    const depositAmount = 100_000_000n; // 100 STX (in micro-STX)

    const receipt = simnet.callPublicFn(
      "streamflow-liquidity",
      "deposit-liquidity",
      [Cl.uint(depositAmount)],
      provider
    );

    // Expect an ok(uint) response with the new balance
    expect(receipt.result).toBeOk(Cl.uint(depositAmount));

    const balanceRead = simnet.callReadOnlyFn(
      "streamflow-liquidity",
      "get-liquidity",
      [Cl.standardPrincipal(provider)],
      provider
    );

    expect(balanceRead.result).toBeOk(Cl.uint(depositAmount));
  });

  it("allows a provider to withdraw part of their liquidity", () => {
    const provider = simnet.wallet_1;

    const initialDeposit = 200_000_000n;
    const withdrawAmount = 50_000_000n;

    simnet.callPublicFn(
      "streamflow-liquidity",
      "deposit-liquidity",
      [Cl.uint(initialDeposit)],
      provider
    );

    const withdrawReceipt = simnet.callPublicFn(
      "streamflow-liquidity",
      "withdraw-liquidity",
      [Cl.uint(withdrawAmount)],
      provider
    );

    const expectedRemaining = initialDeposit - withdrawAmount;

    expect(withdrawReceipt.result).toBeOk(Cl.uint(expectedRemaining));

    const balanceRead = simnet.callReadOnlyFn(
      "streamflow-liquidity",
      "get-liquidity",
      [Cl.standardPrincipal(provider)],
      provider
    );

    expect(balanceRead.result).toBeOk(Cl.uint(expectedRemaining));
  });

  it("rejects withdrawals greater than current liquidity", () => {
    const provider = simnet.wallet_2;

    const depositAmount = 10_000_000n;
    const tooMuch = 20_000_000n;

    simnet.callPublicFn(
      "streamflow-liquidity",
      "deposit-liquidity",
      [Cl.uint(depositAmount)],
      provider
    );

    const withdrawReceipt = simnet.callPublicFn(
      "streamflow-liquidity",
      "withdraw-liquidity",
      [Cl.uint(tooMuch)],
      provider
    );

    // ERR_INSUFFICIENT_LIQUIDITY = (err u103)
    expect(withdrawReceipt.result).toBeErr(Cl.uint(103));
  });
});


describe("streamflow-liquidity :: streaming", () => {
  it("creates a stream and reduces provider liquidity", () => {
    const provider = simnet.wallet_3;
    const recipient = simnet.wallet_4;

    const liquidity = 300_000_000n;
    const depositForStream = 120_000_000n;
    const duration = 10n; // blocks

    simnet.callPublicFn(
      "streamflow-liquidity",
      "deposit-liquidity",
      [Cl.uint(liquidity)],
      provider
    );

    const createReceipt = simnet.callPublicFn(
      "streamflow-liquidity",
      "create-stream",
      [Cl.principal(recipient.address), Cl.uint(depositForStream), Cl.uint(duration)],
      provider
    );

    // Expect ok(stream-id)
    const streamId = createReceipt.result.value; // uint CV under ok

    const liquidityRead = simnet.callReadOnlyFn(
      "streamflow-liquidity",
      "get-liquidity",
      [Cl.standardPrincipal(provider)],
      provider
    );

    const expectedRemaining = liquidity - depositForStream;
    expect(liquidityRead.result).toBeOk(Cl.uint(expectedRemaining));

    const streamRead = simnet.callReadOnlyFn(
      "streamflow-liquidity",
      "get-stream",
      [Cl.uint(streamId.value)],
      provider
    );

    // Check that the stream owner/recipient/deposit match
    expect(streamRead.result).toBeOk(
      Cl.tuple({
        owner: Cl.standardPrincipal(provider),
        recipient: Cl.standardPrincipal(recipient),
        deposit: Cl.uint(depositForStream),
        // other fields (start-block, end-block, withdrawn, cancelled)
      })
    );
  });

  it("does not allow recipient to withdraw before anything is vested", () => {
    const provider = simnet.wallet_5;
    const recipient = simnet.wallet_6;

    const liquidity = 50_000_000n;
    const depositForStream = 20_000_000n;
    const duration = 100n; // long duration so very little is vested at start

    simnet.callPublicFn(
      "streamflow-liquidity",
      "deposit-liquidity",
      [Cl.uint(liquidity)],
      provider
    );

    const createReceipt = simnet.callPublicFn(
      "streamflow-liquidity",
      "create-stream",
      [Cl.principal(recipient.address), Cl.uint(depositForStream), Cl.uint(duration)],
      provider
    );

    const streamId = createReceipt.result.value;

    const withdrawAttempt = simnet.callPublicFn(
      "streamflow-liquidity",
      "withdraw-from-stream",
      [Cl.uint(streamId.value)],
      recipient
    );

    // ERR_NOTHING_TO_CLAIM = (err u104)
    expect(withdrawAttempt.result).toBeErr(Cl.uint(104));
  });

  it("enforces access control when cancelling a stream", () => {
    const owner = simnet.wallet_7;
    const recipient = simnet.wallet_8;
    const attacker = simnet.wallet_9;

    const liquidity = 80_000_000n;
    const depositForStream = 40_000_000n;
    const duration = 20n;

    simnet.callPublicFn(
      "streamflow-liquidity",
      "deposit-liquidity",
      [Cl.uint(liquidity)],
      owner
    );

    const createReceipt = simnet.callPublicFn(
      "streamflow-liquidity",
      "create-stream",
      [Cl.principal(recipient.address), Cl.uint(depositForStream), Cl.uint(duration)],
      owner
    );

    const streamId = createReceipt.result.value;

    // Attacker should not be able to cancel
    const attackerCancel = simnet.callPublicFn(
      "streamflow-liquidity",
      "cancel-stream",
      [Cl.uint(streamId.value)],
      attacker
    );

    // ERR_UNAUTHORIZED = (err u100)
    expect(attackerCancel.result).toBeErr(Cl.uint(100));

    // Owner can cancel once
    const ownerCancel = simnet.callPublicFn(
      "streamflow-liquidity",
      "cancel-stream",
      [Cl.uint(streamId.value)],
      owner
    );

    expect(ownerCancel.result).toBeOk();

    // Cancelling again should fail with ERR_ALREADY_CANCELLED = (err u105)
    const secondCancel = simnet.callPublicFn(
      "streamflow-liquidity",
      "cancel-stream",
      [Cl.uint(streamId.value)],
      owner
    );

    expect(secondCancel.result).toBeErr(Cl.uint(105));
  });
});

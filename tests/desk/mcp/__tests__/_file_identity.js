// The one way a test makes a file identity (an `ino` or a `dev`) that differs from a real one, to stand for "a different file".
//
// Never write `ino + 1` or `ino - 1` in a test. On Windows a file id can exceed 2^53 (one was measured at 10414574139658612), where a JavaScript Number cannot tell n from n + 1, so the "different" identity equals the real one and the test checks nothing. `different` returns a value that is never equal to its argument, whatever its type and size. `file_identity_arithmetic.test.js` fails any other test that does arithmetic on `ino` or `dev`.

/** A value of the same type as `identity` (Number, BigInt or decimal string) that is not equal to it. */
export function different(identity) {
  if (typeof identity === "bigint") return identity + 1n
  if (typeof identity === "string") return `${identity}0`
  let step = 1
  while (identity + step === identity) step *= 2
  return identity + step
}

/** `{ dev, ino }` naming another file than the one `identity` names: the device stays, the file id changes. */
export function otherFile({ dev, ino }) {
  return { dev, ino: different(ino) }
}

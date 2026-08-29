export const MIB = 1024 * 1024;

export const ZSTD_COMPRESSED_HARD_LIMIT_BYTES = 64 * MIB;
export const ZSTD_DECODED_HARD_LIMIT_BYTES = 64 * MIB;
// Every zstd request initially reserves the full decode ceiling plus its wire
// bytes. Keep the configurable process budget large enough to admit at least a
// small valid request instead of accepting a setting that makes zstd unusable.
export const MIN_ZSTD_MEMORY_BUDGET_BYTES = ZSTD_DECODED_HARD_LIMIT_BYTES + MIB;

// One worst-case request can occupy a 64 MiB wire buffer while a 64 MiB
// logical body is decoded, converted to a JavaScript string, and parsed. The
// weighted budget is deliberately larger than the two protocol limits: those
// limits bound one request, while this limit bounds aggregate process memory.
export const DEFAULT_ZSTD_MEMORY_BUDGET_BYTES = 256 * MIB;

// Parsed JSON is mostly strings for Codex history. Three logical bytes per
// input byte conservatively covers UTF-16 text plus object/string overhead
// after the compressed and decoded byte buffers leave scope.
export const ZSTD_PARSED_BODY_MEMORY_FACTOR = 3;
export const ZSTD_MIN_PARSED_BODY_CHARGE_BYTES = 64 * 1024;

function validBytes(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export class WeightedByteBudget {
  #capacityBytes;
  #usedBytes = 0;

  constructor(capacityBytes = DEFAULT_ZSTD_MEMORY_BUDGET_BYTES) {
    if (!validBytes(capacityBytes) || capacityBytes === 0) {
      throw new TypeError("WeightedByteBudget capacity must be a positive safe integer.");
    }
    this.#capacityBytes = capacityBytes;
  }

  get capacityBytes() {
    return this.#capacityBytes;
  }

  get usedBytes() {
    return this.#usedBytes;
  }

  tryReserve(bytes) {
    if (!validBytes(bytes)) throw new TypeError("Reservation size must be a non-negative safe integer.");
    if (bytes > this.#capacityBytes - this.#usedBytes) return null;
    this.#usedBytes += bytes;
    let heldBytes = bytes;
    let released = false;
    return {
      get bytes() {
        return heldBytes;
      },
      resize: (nextBytes) => {
        if (released) return false;
        if (!validBytes(nextBytes)) throw new TypeError("Reservation size must be a non-negative safe integer.");
        const delta = nextBytes - heldBytes;
        if (delta > 0 && delta > this.#capacityBytes - this.#usedBytes) return false;
        this.#usedBytes += delta;
        heldBytes = nextBytes;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#usedBytes -= heldBytes;
        heldBytes = 0;
      },
    };
  }
}

export function zstdReceiveChargeBytes(wireBytes) {
  return ZSTD_DECODED_HARD_LIMIT_BYTES + wireBytes;
}

export function zstdParseChargeBytes(wireBytes, logicalBytes) {
  return wireBytes + logicalBytes * ZSTD_PARSED_BODY_MEMORY_FACTOR;
}

export function zstdParsedBodyChargeBytes(logicalBytes) {
  return Math.max(
    ZSTD_MIN_PARSED_BODY_CHARGE_BYTES,
    logicalBytes * ZSTD_PARSED_BODY_MEMORY_FACTOR,
  );
}

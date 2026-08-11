#!/usr/bin/env python3
"""Drop the duplicated `output.weight` tensor from a GGUF (ai-bundle-slim myne#190 option A).

This is the recipe `src-tauri/resources/models/tag/README.md` points at. It is
tooling, not a guard — nothing in CI runs it; it is here so the shipped model's
provenance is reproducible by anyone with the first-party GGUF.

Qwen2.5-0.5B-Instruct is a tied-embedding model and the GGUF materializes the tied
LM head twice: `output.weight` (Q8_0, 137.94 MiB) is `token_embd.weight` (Q5_0,
89.26 MiB) at higher precision. candle 0.8.4 already handles the absence —
`quantized_qwen2.rs:211-217` falls back to `token_embd.weight` with the comment
`// use tie_word_embeddings`.

**No requantization.** Every remaining tensor keeps its exact bytes: the KV block
is copied verbatim (so no metadata value can be normalized by a re-serializer),
and the tensor data is copied as one contiguous range. Only three things change:
the header's tensor count, the tensor-info table (one entry gone, offsets
shifted), and the padding.

Usage:  scripts/strip-gguf-tensor.py <in.gguf> <out.gguf>
"""

import os
import shutil
import struct
import sys

DROP = "output.weight"
CHUNK = 8 << 20


def main(src: str, dst: str) -> int:
    f = open(src, "rb")
    rd32 = lambda: struct.unpack("<I", f.read(4))[0]  # noqa: E731
    rd64 = lambda: struct.unpack("<Q", f.read(8))[0]  # noqa: E731

    def rstr() -> str:
        return f.read(rd64()).decode("utf-8")

    def skipval(t: int) -> None:
        if t in (0, 1, 7):
            f.read(1)
        elif t in (2, 3):
            f.read(2)
        elif t in (4, 5, 6):
            f.read(4)
        elif t in (10, 11, 12):
            f.read(8)
        elif t == 8:
            f.read(rd64())
        elif t == 9:
            et = rd32()
            for _ in range(rd64()):
                skipval(et)
        else:
            raise ValueError(f"unknown GGUF value type {t}")

    magic = f.read(4)
    if magic != b"GGUF":
        raise SystemExit(f"not a GGUF file: {magic!r}")
    version = rd32()
    n_tensors = rd64()
    n_kv = rd64()

    kv_start = f.tell()
    align = 32
    for _ in range(n_kv):
        key = rstr()
        t = rd32()
        if key == "general.alignment":
            at = f.tell()
            align = rd32()
            f.seek(at)
        skipval(t)
    kv_end = f.tell()

    infos = []
    for _ in range(n_tensors):
        name = rstr()
        nd = rd32()
        dims = [rd64() for _ in range(nd)]
        ty = rd32()
        off = rd64()
        infos.append([name, dims, ty, off])
    ti_end = f.tell()
    data_start = (ti_end + align - 1) // align * align
    file_size = os.path.getsize(src)

    hit = [i for i, t in enumerate(infos) if t[0] == DROP]
    if len(hit) != 1:
        raise SystemExit(f"expected exactly one {DROP}, found {len(hit)}")
    idx = hit[0]
    drop_off = infos[idx][3]
    # Offsets are ascending in file order (asserted), so the dropped tensor's
    # span runs to the next one — or to the end of the data section.
    ordered = sorted(t[3] for t in infos)
    if ordered != [t[3] for t in infos]:
        raise SystemExit("tensor offsets are not ascending; this script assumes they are")
    drop_end = infos[idx + 1][3] if idx + 1 < len(infos) else file_size - data_start
    drop_span = drop_end - drop_off
    if idx != 0 or drop_off != 0:
        raise SystemExit(
            f"{DROP} is not the first tensor (index {idx}, offset {drop_off}); "
            "the contiguous-copy shortcut below does not hold"
        )

    kept = infos[:idx] + infos[idx + 1 :]
    for t in kept:
        t[3] -= drop_span

    out = open(dst, "wb")
    out.write(b"GGUF")
    out.write(struct.pack("<I", version))
    out.write(struct.pack("<Q", len(kept)))
    out.write(struct.pack("<Q", n_kv))

    # KV block, byte for byte.
    f.seek(kv_start)
    out.write(f.read(kv_end - kv_start))

    for name, dims, ty, off in kept:
        nb = name.encode("utf-8")
        out.write(struct.pack("<Q", len(nb)))
        out.write(nb)
        out.write(struct.pack("<I", len(dims)))
        for d in dims:
            out.write(struct.pack("<Q", d))
        out.write(struct.pack("<I", ty))
        out.write(struct.pack("<Q", off))

    pad = (-out.tell()) % align
    out.write(b"\x00" * pad)

    # The remaining tensor data, as one contiguous range.
    f.seek(data_start + drop_span)
    shutil.copyfileobj(f, out, CHUNK)
    out.close()
    f.close()

    new_size = os.path.getsize(dst)
    print(f"dropped {DROP}: {drop_span} bytes ({drop_span / 1048576:.2f} MiB)")
    print(f"tensors {n_tensors} -> {len(kept)}   alignment {align}")
    print(f"{file_size} -> {new_size} bytes  ({file_size / 1048576:.2f} -> {new_size / 1048576:.2f} MiB)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))

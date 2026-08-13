#!/usr/bin/env python3
"""Wake-word detection sidecar for JerryBot 2.0's "Hey Jerry" voice pipeline.

This is a single long-lived process that handles up to 16 audio "slots" (one
per active user). Each slot gets its own openwakeword.Model instance so that
one user's rolling audio state can never contaminate another's detection.
Slots are created lazily on first use.

Wire protocol (stdin, binary framed messages, read in a loop):
    uint8    slot          (0-15)
    uint16LE sampleCount
    int16LE  samples[sampleCount]

A frame with sampleCount == 0 is a control message meaning "release slot N":
    drop that slot's model instance and buffered audio; no sample bytes
    follow the header for this message.

Wire protocol (stdout, one JSON object per line):
    {"slot": <int>, "score": <float>}   -- emitted on wake-word detection

All diagnostics/logging go to stderr, never stdout (stdout is reserved for
the detection protocol). The process exits 0 on stdin EOF.

Audio must be 16kHz mono int16 PCM. openWakeWord predicts on 1280-sample
(80ms) frames; the Node side (feedAudio) may send arbitrary frame sizes, so
this sidecar buffers per-slot input up to 1280-sample chunks internally.

After a detection on a slot, further detections on that slot are suppressed
for a refractory period, and the slot's model state is reset so trailing
wake-phrase audio can't double-trigger.
"""
import argparse
import json
import os
import struct
import sys
import time

import numpy as np

REFRACTORY_SECONDS = 2.0
FRAME_SAMPLES = 1280
HEADER_FORMAT = '<BH'  # uint8 slot, uint16LE sampleCount
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def read_exact(stream, n):
    """Read exactly n bytes from a buffered stream, or None on EOF/short read."""
    if n == 0:
        return b''
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


class SlotState:
    __slots__ = ('model', 'buffer', 'refractory_until')

    def __init__(self, model):
        self.model = model
        self.buffer = np.empty(0, dtype=np.int16)
        self.refractory_until = 0.0


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_model = os.path.join(script_dir, '..', 'tools', 'models', 'hey_jarvis_v0.1.onnx')

    parser = argparse.ArgumentParser(description='openWakeWord multi-slot sidecar')
    parser.add_argument('--model', default=default_model, help='Path to the wake-word ONNX model')
    parser.add_argument('--threshold', type=float, default=0.5, help='Detection score threshold (0-1)')
    args = parser.parse_args()

    model_path = os.path.abspath(args.model)
    model_dir = os.path.dirname(model_path)
    # The melspectrogram/embedding feature models live alongside the
    # wake-word model in tools/models/ (see Task 1's setup-voice.sh).
    melspec_path = os.path.join(model_dir, 'melspectrogram.onnx')
    embedding_path = os.path.join(model_dir, 'embedding_model.onnx')

    from openwakeword.model import Model

    def new_model():
        return Model(
            wakeword_model_paths=[model_path],
            melspec_onnx_model_path=melspec_path,
            embedding_onnx_model_path=embedding_path,
        )

    slots = {}
    stdin = sys.stdin.buffer
    stdout = sys.stdout

    log(f'[wakeword_sidecar] ready model={model_path} threshold={args.threshold}')

    while True:
        header = read_exact(stdin, HEADER_SIZE)
        if header is None:
            break
        slot, sample_count = struct.unpack(HEADER_FORMAT, header)

        if sample_count == 0:
            # Control message: release this slot's state.
            slots.pop(slot, None)
            continue

        payload = read_exact(stdin, sample_count * 2)
        if payload is None:
            break

        samples = np.frombuffer(payload, dtype='<i2')

        state = slots.get(slot)
        if state is None:
            try:
                state = SlotState(new_model())
            except Exception as exc:  # noqa: BLE001 - keep sidecar alive on model load failure
                log(f'[wakeword_sidecar] failed to create model for slot {slot}: {exc}')
                continue
            slots[slot] = state

        state.buffer = np.concatenate((state.buffer, samples))

        while len(state.buffer) >= FRAME_SAMPLES:
            chunk = state.buffer[:FRAME_SAMPLES]
            state.buffer = state.buffer[FRAME_SAMPLES:]

            predictions = state.model.predict(chunk)
            score = float(max(predictions.values())) if predictions else 0.0

            now = time.monotonic()
            if score >= args.threshold and now >= state.refractory_until:
                stdout.write(json.dumps({'slot': slot, 'score': score}) + '\n')
                stdout.flush()
                state.refractory_until = now + REFRACTORY_SECONDS
                if hasattr(state.model, 'reset'):
                    state.model.reset()
                else:
                    state.model = new_model()

    log('[wakeword_sidecar] stdin closed, exiting')
    sys.exit(0)


if __name__ == '__main__':
    main()

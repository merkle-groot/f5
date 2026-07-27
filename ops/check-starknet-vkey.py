#!/usr/bin/env python3
"""Verify that Garaga's checked-in Cairo verifier uses the current withdrawL2 vkey."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


COORDINATES = ("x0", "x1", "y0", "y1")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--vkey",
        default="packages/circuits/build/withdrawL2/groth16_vkey.json",
    )
    parser.add_argument(
        "--constants",
        default="packages/starknet-pool/src/groth16_verifier_constants.cairo",
    )
    return parser.parse_args()


def read_expected_delta(path: Path) -> dict[str, int]:
    vkey = json.loads(path.read_text())
    delta = vkey["vk_delta_2"]
    return {
        "x0": int(delta[0][0]),
        "x1": int(delta[0][1]),
        "y0": int(delta[1][0]),
        "y1": int(delta[1][1]),
    }


def read_cairo_delta(path: Path) -> dict[str, int]:
    source = path.read_text()
    start = source.index("delta_g2: G2Point")
    end = source.index("\n    },\n};", start)
    block = source[start:end]
    result: dict[str, int] = {}

    for coordinate in COORDINATES:
        match = re.search(
            rf"{coordinate}: u384 \{{(.*?)\n        \}},",
            block,
            re.DOTALL,
        )
        if match is None:
            raise ValueError(f"could not find delta_g2.{coordinate}")
        limbs = [
            int(value, 16)
            for value in re.findall(r"limb\d+: (0x[0-9a-fA-F]+)", match.group(1))
        ]
        if len(limbs) != 4:
            raise ValueError(
                f"delta_g2.{coordinate} has {len(limbs)} limbs instead of 4"
            )
        result[coordinate] = sum(value << (96 * index) for index, value in enumerate(limbs))

    return result


def main() -> int:
    args = parse_args()
    vkey_path = Path(args.vkey)
    constants_path = Path(args.constants)

    try:
        expected = read_expected_delta(vkey_path)
        actual = read_cairo_delta(constants_path)
    except (OSError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"could not validate Starknet verifier constants: {error}", file=sys.stderr)
        return 2

    mismatches = [
        coordinate
        for coordinate in COORDINATES
        if expected[coordinate] != actual[coordinate]
    ]
    if mismatches:
        print(
            "Starknet Cairo verifier constants were generated from DIFFERENT keys "
            f"than the current withdrawL2 vkey (delta mismatch: {', '.join(mismatches)})."
        )
        return 1

    print("Starknet Cairo verifier constants match the current withdrawL2 vkey.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

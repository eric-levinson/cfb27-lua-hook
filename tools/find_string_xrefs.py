"""Locate x64 RIP-relative references to named strings in a PE image."""

from __future__ import annotations

import argparse
from collections import deque
import struct
import sys
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_64, Cs
from capstone.x86 import X86_OP_MEM, X86_REG_RIP


def file_offset_to_rva(pe: pefile.PE, offset: int) -> int | None:
    for section in pe.sections:
        start = section.PointerToRawData
        end = start + section.SizeOfRawData
        if start <= offset < end:
            return section.VirtualAddress + offset - start
    return None


def find_all(data: bytes, needle: bytes) -> list[int]:
    offsets: list[int] = []
    cursor = 0
    while True:
        found = data.find(needle, cursor)
        if found < 0:
            return offsets
        offsets.append(found)
        cursor = found + 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("strings", nargs="+")
    parser.add_argument("--context", type=int, default=5)
    parser.add_argument("--pid", type=int, help="scan decrypted executable memory in a running process")
    parser.add_argument(
        "--target-rva", action="append", default=[],
        help="additional hexadecimal RVA whose RIP-relative code references should be shown",
    )
    args = parser.parse_args()

    data = args.image.read_bytes()
    pe = pefile.PE(data=data, fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    runtime_base = image_base
    read_runtime = None
    if args.pid:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from live_process import process_modules, read_process_bytes

        modules = process_modules(args.pid)
        main = next(
            module for module in modules
            if str(module["path"]).casefold() == str(args.image).casefold()
            or str(module["name"]).casefold() == args.image.name.casefold()
        )
        runtime_base = int(main["base"])
        read_runtime = read_process_bytes
    string_targets: dict[int, str] = {}
    for label in args.strings:
        for encoding, needle in (("ascii", label.encode()), ("utf16", label.encode("utf-16le"))):
            for offset in find_all(data, needle):
                rva = file_offset_to_rva(pe, offset)
                if rva is not None:
                    string_targets[runtime_base + rva] = f"{label} ({encoding}, file+0x{offset:X})"

    # Frostbite registration data often points to strings through a descriptor
    # rather than referencing the characters directly from executable code.
    targets = dict(string_targets)
    for raw_rva in args.target_rva:
        rva = int(raw_rva, 0)
        targets[runtime_base + rva] = f"explicit RVA 0x{rva:X}"
    for string_va, label in string_targets.items():
        pointer = struct.pack("<Q", string_va)
        for offset in find_all(data, pointer):
            rva = file_offset_to_rva(pe, offset)
            if rva is not None:
                targets[runtime_base + rva] = f"descriptor -> {label} (file+0x{offset:X})"

    disassembler = Cs(CS_ARCH_X86, CS_MODE_64)
    disassembler.detail = True
    matches: list[dict[str, object]] = []
    for section in pe.sections:
        if not section.Characteristics & 0x20000000:  # IMAGE_SCN_MEM_EXECUTE
            continue
        section_name = section.Name.rstrip(b"\0").decode(errors="replace")
        if read_runtime:
            section_size = int(section.SizeOfRawData)
            section_address = runtime_base + section.VirtualAddress
            section_data = b"".join(
                read_runtime(args.pid, section_address + offset, min(16 * 1024 * 1024, section_size - offset))
                for offset in range(0, section_size, 16 * 1024 * 1024)
            )
        else:
            section_data = section.get_data()
        previous = deque(maxlen=args.context)
        pending: list[dict[str, object]] = []
        for instruction in disassembler.disasm(
            section_data, runtime_base + section.VirtualAddress
        ):
            for match in list(pending):
                match["instructions"].append(instruction)
                match["remaining"] -= 1
                if match["remaining"] <= 0:
                    pending.remove(match)
            for operand in instruction.operands:
                if operand.type != X86_OP_MEM or operand.mem.base != X86_REG_RIP:
                    continue
                destination = instruction.address + instruction.size + operand.mem.disp
                label = targets.get(destination)
                if label:
                    match = {
                        "section": section_name,
                        "address": instruction.address,
                        "destination": destination,
                        "label": label,
                        "instructions": [*previous, instruction],
                        "remaining": args.context,
                    }
                    matches.append(match)
                    pending.append(match)
            previous.append(instruction)

    print(
        f"image_base=0x{image_base:X} runtime_base=0x{runtime_base:X} "
        f"strings={len(string_targets)} "
        f"targets={len(targets)} xrefs={len(matches)}"
    )
    for target, label in sorted(targets.items()):
        if label.startswith("descriptor"):
            print(f"descriptor VA=0x{target:X}: {label}")
    for match in matches:
        section_name = str(match["section"])
        address = int(match["address"])
        destination = int(match["destination"])
        label = str(match["label"])
        print(
            f"\n{label} VA=0x{destination:X} referenced in {section_name} "
            f"at RVA=0x{address - runtime_base:X}"
        )
        for nearby in match["instructions"]:
            marker = ">" if nearby.address == address else " "
            print(
                f"{marker} 0x{nearby.address - runtime_base:09X}: "
                f"{nearby.mnemonic:<8} {nearby.op_str}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

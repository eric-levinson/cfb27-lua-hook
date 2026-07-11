local base = cfb.module_base()
local first = cfb.read_u8(base)
local second = cfb.read_u8(base + 1)
local matches = cfb.aob_scan("4D 5A", 1)

cfb.log("image header bytes=" .. tostring(first) .. "," .. tostring(second))
cfb.log("MZ matches=" .. tostring(#matches))

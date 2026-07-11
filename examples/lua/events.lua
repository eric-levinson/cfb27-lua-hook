cfb.on("game_ready", function()
    cfb.log("events example saw game_ready")
end)

local ticks = 0
cfb.on("tick", function()
    ticks = ticks + 1
    if ticks % 100 == 0 then
        cfb.log("events example ticks=" .. tostring(ticks))
    end
end)

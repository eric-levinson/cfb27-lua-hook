local ticks = 0

cfb.log("autorun example loaded")

cfb.on("game_ready", function()
    cfb.log("game_ready event")
end)

cfb.on("tick", function()
    ticks = ticks + 1
    if ticks == 10 then
        cfb.log("tick callbacks active")
    end
end)

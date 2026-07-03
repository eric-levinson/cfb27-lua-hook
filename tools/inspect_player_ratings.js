const fs = require("fs");
const path = require("path");
const Franchise = require("madden-franchise");

const schemaPath = path.join(__dirname, "..", "schema", "CFB27_schema_for_madden_franchise.gz");
const filePath = process.argv[2];
const first = (process.argv[3] || "").toLowerCase();
const last = (process.argv[4] || "").toLowerCase();

const fields = [
  "FirstName",
  "LastName",
  "Position",
  "Height",
  "Weight",
  "OverallRating",
  "SpeedRating",
  "AccelerationRating",
  "StrengthRating",
  "AgilityRating",
  "AwarenessRating",
  "JumpingRating",
  "InjuryRating",
  "StaminaRating",
  "ToughnessRating",
  "CarryingRating",
  "BreakTackleRating",
  "TruckingRating",
  "ChangeOfDirectionRating",
  "BCVisionRating",
  "StiffArmRating",
  "SpinMoveRating",
  "JukeMoveRating",
  "BreakSackRating",
  "RunBlockRating",
  "PassBlockRating",
  "ImpactBlockingRating",
  "RunBlockPowerRating",
  "RunBlockFinesseRating",
  "PassBlockPowerRating",
  "PassBlockFinesseRating",
  "LeadBlockRating",
  "ThrowPowerRating",
  "ThrowUnderPressureRating",
  "ThrowAccuracyShortRating",
  "ThrowAccuracyMidRating",
  "ThrowAccuracyDeepRating",
  "ThrowOnTheRunRating",
  "PlayActionRating",
  "TackleRating",
  "PowerMovesRating",
  "FinesseMovesRating",
  "BlockSheddingRating",
  "PursuitRating",
  "PlayRecognitionRating",
  "ManCoverageRating",
  "ZoneCoverageRating",
  "HitPowerRating",
  "PressRating",
  "CatchingRating",
  "SpectacularCatchRating",
  "CatchInTrafficRating",
  "ShortRouteRunningRating",
  "MediumRouteRunningRating",
  "DeepRouteRunningRating",
  "KickPowerRating",
  "KickAccuracyRating",
  "KickReturnRating",
];

async function main() {
  const franchise = await Franchise.create(filePath, {
    schemaOverride: { major: 27, minor: 1, gameYear: 26, path: schemaPath },
    gameYearOverride: 26,
    autoParse: true,
  });
  const player = franchise.getTableByName("Player");
  await player.readRecords(fields);
  const matches = [];
  for (let i = 0; i < player.records.length; i += 1) {
    const record = player.records[i];
    if (record.isEmpty) continue;
    if (
      String(record.FirstName || "").toLowerCase() === first &&
      String(record.LastName || "").toLowerCase() === last
    ) {
      const row = { row: i };
      for (const field of fields) row[field] = record[field];
      matches.push(row);
    }
  }
  console.log(JSON.stringify(matches, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

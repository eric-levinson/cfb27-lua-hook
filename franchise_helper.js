const fs = require("fs");
const path = require("path");

const Franchise = require("madden-franchise");
const utilService = require("madden-franchise/services/utilService");

const SCHEMA_PATH = path.join(__dirname, "schema", "CFB27_schema_for_madden_franchise.gz");
const GAME_YEAR = 26;
const PLAYER_TABLE = "Player";
const RECRUIT_TABLE = "Recruit";

const POSITIONS = [
  "QB",
  "HB",
  "FB",
  "WR",
  "TE",
  "LT",
  "LG",
  "C",
  "RG",
  "RT",
  "LE",
  "RE",
  "DT",
  "LOLB",
  "MLB",
  "ROLB",
  "CB",
  "FS",
  "SS",
  "K",
  "P",
  "LS",
  "KR",
  "PR",
];

const RATING_FIELDS = [
  ["overall", "OVR", "Overall", "OverallRating", "General", 0, 100],
  ["speed", "SPD", "Speed", "SpeedRating", "General", 0, 99],
  ["acceleration", "ACC", "Acceleration", "AccelerationRating", "General", 0, 99],
  ["strength", "STR", "Strength", "StrengthRating", "General", 0, 99],
  ["agility", "AGI", "Agility", "AgilityRating", "General", 0, 99],
  ["awareness", "AWR", "Awareness", "AwarenessRating", "General", 0, 99],
  ["jumping", "JMP", "Jumping", "JumpingRating", "General", 0, 99],
  ["injury", "INJ", "Injury", "InjuryRating", "General", 0, 99],
  ["stamina", "STA", "Stamina", "StaminaRating", "General", 0, 99],
  ["toughness", "TGH", "Toughness", "ToughnessRating", "General", 0, 99],
  ["carrying", "CAR", "Carrying", "CarryingRating", "Ballcarrier", 0, 99],
  ["break_tackle", "BTK", "Break Tackle", "BreakTackleRating", "Ballcarrier", 0, 99],
  ["trucking", "TRK", "Trucking", "TruckingRating", "Ballcarrier", 0, 99],
  ["change_of_direction", "COD", "Change Of Direction", "ChangeOfDirectionRating", "Ballcarrier", 0, 99],
  ["bc_vision", "BCV", "BC Vision", "BCVisionRating", "Ballcarrier", 0, 99],
  ["stiff_arm", "SFA", "Stiff Arm", "StiffArmRating", "Ballcarrier", 0, 99],
  ["spin_move", "SPM", "Spin Move", "SpinMoveRating", "Ballcarrier", 0, 99],
  ["juke_move", "JKM", "Juke Move", "JukeMoveRating", "Ballcarrier", 0, 99],
  ["break_sack", "BSK", "Break Sack", "BreakSackRating", "Ballcarrier", 0, 99],
  ["run_block", "RBK", "Run Block", "RunBlockRating", "Blocking", 0, 99],
  ["pass_block", "PBK", "Pass Block", "PassBlockRating", "Blocking", 0, 99],
  ["impact_blocking", "IBL", "Impact Blocking", "ImpactBlockingRating", "Blocking", 0, 99],
  ["run_block_power", "RBP", "Run Block Power", "RunBlockPowerRating", "Blocking", 0, 99],
  ["run_block_finesse", "RBF", "Run Block Finesse", "RunBlockFinesseRating", "Blocking", 0, 99],
  ["pass_block_power", "PBP", "Pass Block Power", "PassBlockPowerRating", "Blocking", 0, 99],
  ["pass_block_finesse", "PBF", "Pass Block Finesse", "PassBlockFinesseRating", "Blocking", 0, 99],
  ["lead_block", "LBK", "Lead Block", "LeadBlockRating", "Blocking", 0, 99],
  ["throw_power", "THP", "Throw Power", "ThrowPowerRating", "Passing", 0, 99],
  ["throw_under_pressure", "TUP", "Throw Under Pressure", "ThrowUnderPressureRating", "Passing", 0, 99],
  ["throw_accuracy_short", "SAC", "Throw Accuracy Short", "ThrowAccuracyShortRating", "Passing", 0, 99],
  ["throw_accuracy_mid", "MAC", "Throw Accuracy Mid", "ThrowAccuracyMidRating", "Passing", 0, 99],
  ["throw_accuracy_deep", "DAC", "Throw Accuracy Deep", "ThrowAccuracyDeepRating", "Passing", 0, 99],
  ["throw_on_the_run", "TOR", "Throw On The Run", "ThrowOnTheRunRating", "Passing", 0, 99],
  ["play_action", "PAC", "Play Action", "PlayActionRating", "Passing", 0, 99],
  ["tackle", "TAK", "Tackle", "TackleRating", "Defense", 0, 99],
  ["power_moves", "PMV", "Power Moves", "PowerMovesRating", "Defense", 0, 99],
  ["finesse_moves", "FMV", "Finesse Moves", "FinesseMovesRating", "Defense", 0, 99],
  ["block_shedding", "BSH", "Block Shedding", "BlockSheddingRating", "Defense", 0, 99],
  ["pursuit", "PUR", "Pursuit", "PursuitRating", "Defense", 0, 99],
  ["play_recognition", "PRC", "Play Recognition", "PlayRecognitionRating", "Defense", 0, 99],
  ["man_coverage", "MCV", "Man Coverage", "ManCoverageRating", "Defense", 0, 99],
  ["zone_coverage", "ZCV", "Zone Coverage", "ZoneCoverageRating", "Defense", 0, 99],
  ["hit_power", "POW", "Hit Power", "HitPowerRating", "Defense", 0, 99],
  ["press", "PRS", "Press", "PressRating", "Defense", 0, 99],
  ["catching", "CTH", "Catching", "CatchingRating", "Receiving", 0, 99],
  ["spectacular_catch", "SPC", "Spectacular Catch", "SpectacularCatchRating", "Receiving", 0, 99],
  ["catch_in_traffic", "CIT", "Catch In Traffic", "CatchInTrafficRating", "Receiving", 0, 99],
  ["short_route_running", "SRR", "Short Route Running", "ShortRouteRunningRating", "Receiving", 0, 99],
  ["medium_route_running", "MRR", "Medium Route Running", "MediumRouteRunningRating", "Receiving", 0, 99],
  ["deep_route_running", "DRR", "Deep Route Running", "DeepRouteRunningRating", "Receiving", 0, 99],
  ["kick_power", "KPW", "Kick Power", "KickPowerRating", "Kicking", 0, 99],
  ["kick_accuracy", "KAC", "Kick Accuracy", "KickAccuracyRating", "Kicking", 0, 99],
  ["kick_return", "KRT", "Kick Return", "KickReturnRating", "Kicking", 0, 99],
];

function fail(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

function cleanString(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be text`);
  }
  const trimmed = value.trim();
  if (!/^[\x20-\x7E]*$/.test(trimmed)) {
    throw new Error(`${label} must contain printable ASCII only`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long; max ${maxLength} characters`);
  }
  return trimmed;
}

function cleanInt(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function heightDisplay(inches) {
  const raw = Number(inches);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  return `${Math.floor(raw / 12)}'${raw % 12}"`;
}

function poundsFromRaw(rawWeight) {
  const raw = Number(rawWeight);
  if (!Number.isFinite(raw)) return "";
  return raw + 160;
}

function visualHintsFromHeadAsset(headAsset) {
  const match = String(headAsset || "").match(/^Generic_\d+_P_T\d+_([A-Z])_(\d+)_(\d+)$/);
  if (!match) {
    return { skinTone: "", hair: "" };
  }
  return {
    skinTone: match[2],
    hair: `${match[1]}-${match[3]}`,
  };
}

function getReference(value) {
  if (!value || typeof value !== "string" || !/^[01]+$/.test(value)) {
    return null;
  }
  return utilService.getReferenceData(value);
}

async function loadFranchise(filePath) {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`Missing schema file: ${SCHEMA_PATH}`);
  }
  return Franchise.create(filePath, {
    schemaOverride: {
      major: 27,
      minor: 1,
      gameYear: GAME_YEAR,
      path: SCHEMA_PATH,
    },
    gameYearOverride: GAME_YEAR,
    autoParse: true,
  });
}

async function readRecruitTables(franchise) {
  const recruitTable = franchise.getTableByName(RECRUIT_TABLE);
  const playerTable = franchise.getTableByName(PLAYER_TABLE);
  if (!recruitTable || !playerTable) {
    throw new Error("Recruit or Player table was not found in this save");
  }

  await recruitTable.readRecords(["NationalRank", "PositionRank", "StateRank", "Player"]);
  await playerTable.readRecords([
    "FirstName",
    "LastName",
    "Height",
    "Weight",
    "Position",
    "GenericHeadAssetName",
    "PLYR_GENERICHEAD",
    "CharacterVisuals",
    ...RATING_FIELDS.map((field) => field[3]),
  ]);

  return { recruitTable, playerTable };
}

function recruitPlayerPair(recruitRecord, recruitIndex, playerTable) {
  if (!recruitRecord || recruitRecord.isEmpty) return null;
  const ref = getReference(recruitRecord.Player);
  if (!ref || ref.tableId !== playerTable.header.tableId) return null;
  const playerRecord = playerTable.records[ref.rowNumber];
  if (!playerRecord || playerRecord.isEmpty) return null;
  const firstName = playerRecord.FirstName || "";
  const lastName = playerRecord.LastName || "";
  if (!firstName && !lastName) return null;
  return {
    recruitRecord,
    recruitIndex,
    playerRecord,
    playerIndex: ref.rowNumber,
  };
}

function rowFromPair(pair) {
  const { recruitRecord, recruitIndex, playerRecord, playerIndex } = pair;
  const height = Number(playerRecord.Height || 0);
  const rawWeight = Number(playerRecord.Weight || 0);
  const genericHead = playerRecord.PLYR_GENERICHEAD || "";
  const headAsset = playerRecord.GenericHeadAssetName || "";
  const visualHints = visualHintsFromHeadAsset(headAsset);
  const row = {
    id: String(recruitIndex),
    recruit_index: recruitIndex,
    player_index: playerIndex,
    national_rank: Number(recruitRecord.NationalRank || 0),
    position_rank: Number(recruitRecord.PositionRank || 0),
    state_rank: Number(recruitRecord.StateRank || 0),
    first_name: playerRecord.FirstName || "",
    last_name: playerRecord.LastName || "",
    position: playerRecord.Position || "",
    height_inches: height,
    height_display: heightDisplay(height),
    weight_lbs: poundsFromRaw(rawWeight),
    weight_raw: rawWeight,
    generic_head_asset_name: headAsset,
    generic_head: genericHead,
    skin_tone: visualHints.skinTone,
    hair: visualHints.hair,
    character_visuals_ref: playerRecord.CharacterVisuals || "",
  };
  for (const [key, , , schemaField] of RATING_FIELDS) {
    row[key] = Number(playerRecord[schemaField] || 0);
  }
  return row;
}

function sortRecruitRows(a, b) {
  const rankA = a.national_rank > 0 ? a.national_rank : Number.MAX_SAFE_INTEGER;
  const rankB = b.national_rank > 0 ? b.national_rank : Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`);
}

async function listRecruits(filePath, limit, offset) {
  const franchise = await loadFranchise(filePath);
  const { recruitTable, playerTable } = await readRecruitTables(franchise);
  const rows = [];
  for (let index = 0; index < recruitTable.records.length; index += 1) {
    const pair = recruitPlayerPair(recruitTable.records[index], index, playerTable);
    if (pair) rows.push(rowFromPair(pair));
  }
  rows.sort(sortRecruitRows);
  const start = Math.max(0, offset || 0);
  const stop = Math.min(rows.length, start + Math.max(1, Math.min(limit || 1000, 7600)));
  return {
    recordCount: rows.length,
    offset: start,
    limit,
    players: rows.slice(start, stop),
  };
}

function applyPatch(pair, changes) {
  const { recruitRecord, playerRecord } = pair;
  const allowed = new Set([
    "first_name",
    "last_name",
    "position",
    "height_inches",
    "weight_lbs",
    "national_rank",
    "position_rank",
    "state_rank",
    "generic_head_asset_name",
    ...RATING_FIELDS.map((field) => field[0]),
  ]);
  for (const key of Object.keys(changes)) {
    if (!allowed.has(key)) {
      throw new Error(`${key} is not editable yet`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, "first_name")) {
    playerRecord.FirstName = cleanString(changes.first_name, "First name", 17);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "last_name")) {
    playerRecord.LastName = cleanString(changes.last_name, "Last name", 21);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "position")) {
    const position = String(changes.position || "").trim().toUpperCase();
    if (!POSITIONS.includes(position)) {
      throw new Error(`Position must be one of: ${POSITIONS.join(", ")}`);
    }
    playerRecord.Position = position;
  }
  if (Object.prototype.hasOwnProperty.call(changes, "height_inches")) {
    playerRecord.Height = cleanInt(changes.height_inches, "Height", 48, 96);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "weight_lbs")) {
    const pounds = cleanInt(changes.weight_lbs, "Weight", 160, 415);
    playerRecord.Weight = pounds - 160;
  }
  if (Object.prototype.hasOwnProperty.call(changes, "national_rank")) {
    recruitRecord.NationalRank = cleanInt(changes.national_rank, "National rank", 0, 4500);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "position_rank")) {
    recruitRecord.PositionRank = cleanInt(changes.position_rank, "Position rank", 0, 4000);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "state_rank")) {
    recruitRecord.StateRank = cleanInt(changes.state_rank, "State rank", 0, 4000);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "generic_head_asset_name")) {
    playerRecord.GenericHeadAssetName = cleanString(
      changes.generic_head_asset_name,
      "Head asset",
      33,
    );
  }
  for (const [key, shortLabel, displayLabel, schemaField, , min, max] of RATING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      playerRecord[schemaField] = cleanInt(changes[key], `${displayLabel} (${shortLabel})`, min, max);
    }
  }
}

async function patchRecruit(filePath, patchPath, outputPath) {
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  const recruitIndex = Number(patch.id);
  if (!Number.isInteger(recruitIndex) || recruitIndex < 0) {
    throw new Error("Recruit id is invalid");
  }
  if (!patch.changes || typeof patch.changes !== "object") {
    throw new Error("Patch changes are missing");
  }

  const franchise = await loadFranchise(filePath);
  const { recruitTable, playerTable } = await readRecruitTables(franchise);
  const pair = recruitPlayerPair(recruitTable.records[recruitIndex], recruitIndex, playerTable);
  if (!pair) {
    throw new Error("Recruit row was not found or does not reference a valid player");
  }
  applyPatch(pair, patch.changes);

  // The Python server owns the outer FBCHUNKS/zlib container. Here we only
  // rebuild the decompressed FrTk payload after madden-franchise updates tables.
  const unpacked = franchise.strategy.file.generateUnpackedContents(
    franchise.tables,
    franchise.unpackedFileContents,
  );
  fs.writeFileSync(outputPath, unpacked);

  const verify = await loadFranchise(outputPath);
  const { recruitTable: verifyRecruitTable, playerTable: verifyPlayerTable } = await readRecruitTables(verify);
  const updatedPair = recruitPlayerPair(verifyRecruitTable.records[recruitIndex], recruitIndex, verifyPlayerTable);
  return { player: rowFromPair(updatedPair) };
}

async function main() {
  const [command, filePath, arg1, arg2, arg3] = process.argv.slice(2);
  if (!command || !filePath) {
    fail("Usage: node franchise_helper.js <list|patch> <file> ...");
  }
  if (command === "list") {
    const result = await listRecruits(filePath, Number(arg1 || 1000), Number(arg2 || 0));
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "patch") {
    if (!arg1 || !arg2) fail("Patch requires <patch.json> <output-file>");
    const result = await patchRecruit(filePath, arg1, arg2);
    console.log(JSON.stringify(result));
    return;
  }
  fail(`Unknown command: ${command}`);
}

main().catch((error) => fail(error.stack || error.message));

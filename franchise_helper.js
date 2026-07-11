const fs = require("fs");
const path = require("path");

const Franchise = require("madden-franchise");
const utilService = require("madden-franchise/services/utilService");

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const message = args.map((arg) => String(arg)).join(" ");
  if (message.startsWith("Tried to read ") && message.includes(" as a reference")) return;
  originalConsoleError(...args);
};
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
  const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  if (message.startsWith("Tried to read ") && message.includes(" as a reference")) {
    if (typeof callback === "function") callback();
    return true;
  }
  return originalStderrWrite(chunk, encoding, callback);
};

const SCHEMA_PATH = path.join(__dirname, "schema", "CFB27_809_0.gz");
const SCHEMA_MAJOR = 809;
const SCHEMA_MINOR = 0;
const GAME_YEAR = 27;
const PLAYER_TABLE = "Player";
const RECRUIT_TABLE = "Recruit";
const RECRUITING_DIFF_TABLES = [
  "RecruitingBoard",
  "RecruitTarget",
  "UserRecruitTarget",
  "SchoolOffer",
  "ProspectInteraction",
  "ActiveRecruitingPitch",
  "ActiveRecruitingPitch[]",
  "ActiveVisitInfo",
  "RecruitingActionFeedbackEntry",
  "RecruitingActionFeedbackEntry[]",
  "RecruitingActionBonus",
  "RecruitingActionBonus[]",
  "ProspectTargetSchool",
  "SchoolPipelineInfluence",
  "Team",
  "Recruit",
  "Player",
];

const WEEKLY_ACTION_HOURS = {
  SearchSocialMedia: 5,
  ContactHighSchoolCoaches: 10,
  ContactFriendsAndFamily: 25,
  SendTheHouse: 50,
};

const ACTIVE_RECRUITING_PITCH_TYPES = new Map([
  ["collegeexperience", 0],
  ["college experience", 0],
  ["teamplayer", 1],
  ["team player", 1],
  ["campuspersonality", 2],
  ["campus personality", 2],
  ["gamer", 3],
  ["standardbearer", 4],
  ["standard bearer", 4],
  ["studentofthegame", 5],
  ["student of the game", 5],
  ["hometownhero", 6],
  ["hometown hero", 6],
  ["statusseeker", 7],
  ["status seeker", 7],
  ["theclutch", 8],
  ["the clutch", 8],
  ["primetimeplayer", 9],
  ["primetime player", 9],
  ["coachconnection", 10],
  ["coach connection", 10],
  ["aspirational", 11],
  ["aspirationalgoals", 11],
  ["aspirational goals", 11],
  ["housecall", 12],
  ["house call", 12],
  ["footballinfluencer", 13],
  ["football influencer", 13],
  ["clockedin", 14],
  ["clocked in", 14],
  ["starsearch", 15],
  ["star search", 15],
  ["grassrootstraditionalist", 16],
  ["grassroots traditionalist", 16],
  ["conferencelegend", 17],
  ["conference legend", 17],
  ["sundayplayer", 18],
  ["sunday player", 18],
  ["gymrat", 19],
  ["gym rat", 19],
]);

const ACTIVE_RECRUITING_PITCH_INTENSITIES = new Map([
  ["softsell", 0],
  ["soft sell", 0],
  ["hardsell", 1],
  ["hard sell", 1],
  ["sway", 2],
]);

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

const ABILITY_RANKS = ["None", "Bronze", "Silver", "Gold", "Platinum"];

const DEVELOPMENT_TRAITS = ["Normal", "College_Impact", "College_Star", "College_Elite"];

const PROSPECT_STAR_RATINGS = ["ONE_STAR", "TWO_STAR", "THREE_STAR", "FOUR_STAR", "FIVE_STAR"];

const PROSPECT_STAR_BITS = {
  "000": "ONE_STAR",
  "001": "TWO_STAR",
  "010": "THREE_STAR",
  "011": "FOUR_STAR",
  "100": "FIVE_STAR",
};

const PROSPECT_STAR_VALUE_BITS = Object.fromEntries(
  Object.entries(PROSPECT_STAR_BITS).map(([bits, rating]) => [rating, bits]),
);

const MENTAL_ABILITIES = [
  "None",
  "RoadFanFavorite",
  "Toughness",
  "FieldGeneral",
  "ClutchKicker",
  "Captain",
  "TeamPlayer",
  "ClearHeaded",
  "Headstrong",
  "Adrenaline",
  "HomeFanFavorite",
  "WinningTime",
  "TheNatural",
  "Rhythm",
  "BestFriend",
  "OLRally",
  "DLRally",
  "DBRally",
  "BellCow",
  "HotHead",
];

const DEALBREAKER_OPTIONS = [
  ["AcademicPrestige", "Academic Prestige", 0],
  ["AthleticFacilities", "Athletic Facilities", 1],
  ["BrandExposure", "Brand Exposure", 2],
  ["CampusLifestyle", "Campus Lifestyle", 3],
  ["ChampionshipContender", "Championship Contender", 4],
  ["CoachPrestige", "Coach Prestige", 5],
  ["CoachStability", "Coach Stability", 6],
  ["ConferencePrestige", "Conference Prestige", 7],
  ["PlayingStyle", "Playing Style", 8],
  ["PlayingTime", "Playing Time", 9],
  ["ProPotential", "Pro Potential", 10],
  ["ProgramTradition", "Program Tradition", 11],
  ["ProximityToHome", "Proximity To Home", 12],
  ["StadiumAtmosphere", "Stadium Atmosphere", 13],
  ["Invalid", "Invalid", 15],
];

const DEALBREAKER_BY_KEY = new Map(DEALBREAKER_OPTIONS.map(([key, label, value]) => [key, { key, label, value }]));
const DEALBREAKER_BY_VALUE = new Map(DEALBREAKER_OPTIONS.map(([key, label, value]) => [value, { key, label, value }]));

const PLAYER_TYPE_LABELS = {
  QB_FieldGeneral: "Pocket Passer",
  S_Zone: "Coverage Specialist",
  WR_Physical: "Physical",
  WR_DeepThreat: "Deep Threat",
  WR_Playmaker: "Playmaker",
  WR_Slot: "Slot",
  HB_PowerBack: "Power Back",
  HB_ElusiveBack: "Elusive Back",
  HB_ReceivingBack: "Receiving Back",
  TE_Blocking: "Blocking",
  TE_VerticalThreat: "Vertical Threat",
  TE_Possession: "Possession",
  CB_MantoMan: "Man To Man",
  CB_Zone: "Zone",
  S_RunSupport: "Run Support",
  S_Hybrid: "Hybrid",
};

const PHYSICAL_ABILITIES_BY_PLAYER_TYPE = {
  QB_FieldGeneral: ["Resistance", "Step Up", "Sleight of Hand", "Dot!", "On Time"],
  S_Zone: ["Ballhawk", "Lay Out", "House Call", "Robber", "Knockout"],
};

const MENTAL_ABILITY_LABELS = {
  RoadFanFavorite: "Road Dog",
  HomeFanFavorite: "Home Field Advantage",
  FieldGeneral: "Field General",
  TheNatural: "The Natural",
  DBRally: "Legion",
  OLRally: "O-Line Rally",
  DLRally: "D-Line Rally",
  BellCow: "Bell Cow",
  BestFriend: "Best Friend",
  ClutchKicker: "Clutch Kicker",
  ClearHeaded: "Clear Headed",
  TeamPlayer: "Team Player",
  WinningTime: "Winning Time",
};

const DEVELOPMENT_LABELS = {
  Normal: "Normal",
  College_Impact: "Impact",
  College_Star: "Star",
  College_Elite: "Elite",
  Star: "Star",
  Superstar: "Superstar",
  XFactor: "X-Factor",
  Hidden: "Hidden",
};

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

const RESEARCH_FIELDS = {
  Recruit: [
    "NationalRank",
    "PositionRank",
    "StateRank",
    "QualityModifier",
    "ProductionGrade",
  ],
  Player: [
    "ProspectStarRating",
    "PlayerType",
    "CharacterBodyType",
    "GenericHeadAssetName",
    "PLYR_PORTRAIT",
    "PLYR_GENERICHEAD",
    "SkillGroupCap1",
    "SkillGroupCap2",
    "SkillGroupCap3",
    "SkillGroupCap4",
    "SkillGroupCap5",
    "SkillGroupCap6",
    "PhysicalAbility1",
    "PhysicalAbility2",
    "PhysicalAbility3",
    "PhysicalAbility4",
    "PhysicalAbility5",
    "MentalAbility1",
    "MentalAbility2",
    "MentalAbility3",
    "MentalAbilityRank1",
    "MentalAbilityRank2",
    "MentalAbilityRank3",
  ],
};

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

function rawWeightFromPounds(weightLbs) {
  return weightLbs - 160;
}

function decodeProspectStarRating(value) {
  const text = String(value || "");
  if (PROSPECT_STAR_RATINGS.includes(text)) {
    return text;
  }
  return PROSPECT_STAR_BITS[text.slice(0, 3)] || "";
}

function prospectStarCount(value) {
  const rating = decodeProspectStarRating(value);
  const index = PROSPECT_STAR_RATINGS.indexOf(rating);
  return index >= 0 ? index + 1 : null;
}

function encodeProspectStarRating(currentValue, rating) {
  const bits = PROSPECT_STAR_VALUE_BITS[rating];
  if (!bits) {
    throw new Error(`Star rating must be one of: ${PROSPECT_STAR_RATINGS.join(", ")}`);
  }
  const current = String(currentValue || "");
  const suffix = /^[01]{32}$/.test(current) ? current.slice(3) : "0".repeat(29);
  return `${bits}${suffix}`;
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

function splitTypeName(value) {
  return String(value || "")
    .replace(/^[A-Z]+_/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function displayPlayerType(playerType) {
  return PLAYER_TYPE_LABELS[playerType] || splitTypeName(playerType);
}

function displayMentalAbility(value) {
  if (!value || value === "None") return "None";
  return MENTAL_ABILITY_LABELS[value] || splitTypeName(value);
}

function displayDevelopmentTrait(value) {
  return DEVELOPMENT_LABELS[value] || splitTypeName(value);
}

function decodeDealbreaker(rawValue) {
  const bits = String(rawValue || "");
  if (!/^[01]{4,}/.test(bits)) {
    return { key: "", label: "", raw: bits };
  }
  const value = Number.parseInt(bits.slice(0, 4), 2);
  const mapped = DEALBREAKER_BY_VALUE.get(value);
  return {
    key: mapped ? mapped.key : `Unknown_${value}`,
    label: mapped ? mapped.label : `Unknown ${value}`,
    raw: bits,
  };
}

function encodeDealbreaker(currentRawValue, key) {
  const mapped = DEALBREAKER_BY_KEY.get(key);
  if (!mapped) {
    throw new Error(`Deal breaker must be one of: ${DEALBREAKER_OPTIONS.map(([item]) => item).join(", ")}`);
  }
  const suffix = /^[01]{4,}$/.test(String(currentRawValue || ""))
    ? String(currentRawValue).slice(4)
    : "0".repeat(28);
  return mapped.value.toString(2).padStart(4, "0") + suffix;
}

function physicalAbilityNames(playerType) {
  return PHYSICAL_ABILITIES_BY_PLAYER_TYPE[playerType] || ["Physical 1", "Physical 2", "Physical 3", "Physical 4", "Physical 5"];
}

function formatAbilityList(names, ranks) {
  return names
    .map((name, index) => {
      const rank = ranks[index] || "None";
      return rank === "None" ? "" : `${name} (${rank})`;
    })
    .filter(Boolean)
    .join(", ");
}

function getReference(value) {
  if (!value || typeof value !== "string" || !/^[01]+$/.test(value)) {
    return null;
  }
  return utilService.getReferenceData(value);
}

async function loadFranchise(filePath, options = {}) {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`Missing schema file: ${SCHEMA_PATH}`);
  }
  return Franchise.create(filePath, {
    schemaOverride: {
      major: SCHEMA_MAJOR,
      minor: SCHEMA_MINOR,
      gameYear: GAME_YEAR,
      path: SCHEMA_PATH,
    },
    gameYearOverride: GAME_YEAR,
    autoParse: true,
    autoUnempty: Boolean(options.autoUnempty),
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
    "JerseyNum",
    "PlayerType",
    "ProspectStarRating",
    "TraitDevelopment",
    "RecruitingDealbreaker",
    "MentalAbility1",
    "MentalAbility2",
    "MentalAbility3",
    "MentalAbilityRank1",
    "MentalAbilityRank2",
    "MentalAbilityRank3",
    "PhysicalAbility1",
    "PhysicalAbility2",
    "PhysicalAbility3",
    "PhysicalAbility4",
    "PhysicalAbility5",
    "GenericHeadAssetName",
    "PLYR_GENERICHEAD",
    "CharacterVisuals",
    ...RATING_FIELDS.map((field) => field[3]),
  ]);

  return { recruitTable, playerTable };
}

async function readRecruitResearchTables(franchise) {
  const recruitTable = franchise.getTableByName(RECRUIT_TABLE);
  const playerTable = franchise.getTableByName(PLAYER_TABLE);
  if (!recruitTable || !playerTable) {
    throw new Error("Recruit or Player table was not found in this save");
  }

  await recruitTable.readRecords();
  await playerTable.readRecords();
  return { recruitTable, playerTable };
}

async function searchPlayers(filePath, query, limit = 100) {
  const franchise = await loadFranchise(filePath);
  const playerTable = franchise.getTableByName(PLAYER_TABLE);
  if (!playerTable) throw new Error("Player table was not found in this save");
  const fields = [
    "FirstName",
    "LastName",
    "Position",
    "JerseyNum",
    "PlayerType",
    "TraitDevelopment",
    "GenericHeadAssetName",
    "PLYR_GENERICHEAD",
    ...RATING_FIELDS.map((field) => field[3]),
  ];
  await playerTable.readRecords(fields);
  const needle = String(query || "").trim().toLowerCase();
  const matches = [];
  for (let row = 0; row < playerTable.records.length && matches.length < Math.max(1, Math.min(limit, 500)); row += 1) {
    const record = playerTable.records[row];
    if (!record || record.isEmpty) continue;
    const searchable = [
      record.FirstName,
      record.LastName,
      record.GenericHeadAssetName,
      record.PLYR_GENERICHEAD,
    ].map((value) => String(value || "").toLowerCase()).join(" ");
    if (needle && !searchable.includes(needle)) continue;
    const ratings = {};
    for (const [key, shortLabel, displayLabel, schemaField] of RATING_FIELDS) {
      ratings[key] = {
        label: shortLabel,
        display: displayLabel,
        schemaField,
        value: Number(record[schemaField] || 0),
      };
    }
    matches.push({
      row,
      firstName: record.FirstName || "",
      lastName: record.LastName || "",
      position: record.Position || "",
      jerseyNum: Number(record.JerseyNum || 0),
      playerType: record.PlayerType || "",
      development: record.TraitDevelopment || "",
      genericHeadAssetName: record.GenericHeadAssetName || "",
      genericHead: record.PLYR_GENERICHEAD || "",
      ratings,
      rawHex: record._data ? record._data.toString("hex") : "",
      fieldMetadata: fieldMetadata(record),
    });
  }
  return {
    file: path.basename(filePath),
    query: String(query || ""),
    playerTableId: playerTable.header.tableId,
    playerRecordCapacity: playerTable.records.length,
    count: matches.length,
    players: matches,
  };
}

async function buildPlayerRecordPatch(filePath, rowValue, fieldValue, nextValue) {
  const row = Number(rowValue);
  const next = Number(nextValue);
  if (!Number.isInteger(row) || row < 0) throw new Error("Player row must be a non-negative integer");
  if (!Number.isInteger(next)) throw new Error("Player rating value must be an integer");
  const rating = RATING_FIELDS.find(([key, , , schemaField]) => key === fieldValue || schemaField === fieldValue);
  if (!rating) throw new Error(`Unsupported player rating: ${fieldValue}`);
  const [key, , display, schemaField, , minimum, maximum] = rating;
  if (next < minimum || next > maximum) throw new Error(`${schemaField} must be between ${minimum} and ${maximum}`);

  const franchise = await loadFranchise(filePath);
  const playerTable = franchise.getTableByName(PLAYER_TABLE);
  if (!playerTable) throw new Error("Player table was not found in this save");
  await playerTable.readRecords(["FirstName", "LastName", "GenericHeadAssetName", "PresentationId", schemaField]);
  const record = playerTable.records[row];
  if (!record || record.isEmpty) throw new Error(`Player row ${row} is unavailable`);
  const before = Buffer.from(record._data);
  const previous = Number(record[schemaField]);
  record[schemaField] = next;
  const after = Buffer.from(record._data);
  const changes = [];
  for (let offset = 0; offset < before.length; offset += 1) {
    if (before[offset] === after[offset]) continue;
    changes.push({ offset, before: before[offset], after: after[offset] });
  }
  if (!changes.length && previous !== next) throw new Error(`${schemaField} did not produce a record-byte change`);
  return {
    kind: "cfb27.playerRecordPatch.v1",
    file: path.basename(filePath),
    playerTableId: playerTable.header.tableId,
    playerTableUniqueId: playerTable.header.uniqueId,
    recordCapacity: playerTable.records.length,
    recordSize: before.length,
    row,
    player: {
      playerId: Number(record.PresentationId || 0),
      firstName: record.FirstName || "",
      lastName: record.LastName || "",
      genericHeadAssetName: record.GenericHeadAssetName || "",
    },
    field: key,
    display,
    schemaField,
    expectedBefore: previous,
    value: next,
    fieldMetadata: fieldMetadata(record)[schemaField],
    beforeHex: before.toString("hex"),
    afterHex: after.toString("hex"),
    changes,
  };
}

async function buildLeagueEditPermissionPatch(filePath, requestedValue = "ANY") {
  const values = new Map([
    ["NONE", "00"],
    ["COMMISHONLY", "01"],
    ["ANY", "10"],
    ["MAX", "11"],
  ]);
  const normalized = String(requestedValue || "ANY").trim().toUpperCase();
  const encoded = values.get(normalized);
  if (!encoded) throw new Error(`AbilityEditControls must be one of: ${[...values.keys()].join(", ")}`);
  const franchise = await loadFranchise(filePath);
  const table = franchise.tables.find((candidate) => candidate.name === "LeagueSetting");
  if (!table) throw new Error("LeagueSetting table was not found in this Dynasty");
  await table.readRecords(["AbilityEditControls", "FranchiseStyle"]);
  const record = table.records.find((candidate) => candidate && !candidate.isEmpty);
  if (!record) throw new Error("LeagueSetting does not contain an active record");
  const before = Buffer.from(record._data);
  const previous = String(record.AbilityEditControls ?? "");
  record.AbilityEditControls = encoded;
  const after = Buffer.from(record._data);
  const changes = [];
  for (let offset = 0; offset < before.length; offset += 1) {
    if (before[offset] === after[offset]) continue;
    changes.push({ offset, before: before[offset], after: after[offset] });
  }
  return {
    kind: "cfb27.leagueEditPermissionPatch.v1",
    file: path.basename(filePath),
    table: "LeagueSetting",
    tableId: table.header.tableId,
    tableUniqueId: table.header.uniqueId,
    row: record.index,
    recordSize: before.length,
    field: "AbilityEditControls",
    expectedBefore: previous,
    value: normalized,
    encoded,
    fieldMetadata: fieldMetadata(record).AbilityEditControls,
    beforeHex: before.toString("hex"),
    afterHex: after.toString("hex"),
    changes,
  };
}

async function buildFranchiseOwnerPatch(filePath) {
  const franchise = await loadFranchise(filePath);
  const table = franchise.tables.find((candidate) => candidate.name === "FranchiseUser");
  if (!table) throw new Error("FranchiseUser table was not found in this Dynasty");
  await table.readRecords(["AdminLevel"]);
  const record = table.records.find((candidate) => candidate && !candidate.isEmpty);
  if (!record) throw new Error("FranchiseUser does not contain an active record");
  const before = Buffer.from(record._data);
  const after = Buffer.from(before);

  // CFB27 schema 809 stores AdminLevel in the high two bits of byte 36:
  // Owner=00, Commissioner=01, None=10. The current franchise library expands
  // this enum to 32 bits, so write the two schema bits directly and preserve
  // the remaining six bits in the byte.
  const adminByteOffset = 36;
  if (after.length <= adminByteOffset) throw new Error("FranchiseUser record is shorter than the AdminLevel field");
  const encodedBefore = (before[adminByteOffset] >>> 6) & 0x03;
  after[adminByteOffset] &= 0x3f;
  const labels = ["Owner", "Commissioner", "None", "Max"];
  const changes = [];
  for (let offset = 0; offset < before.length; offset += 1) {
    if (before[offset] === after[offset]) continue;
    changes.push({ offset, before: before[offset], after: after[offset] });
  }
  return {
    kind: "cfb27.franchiseOwnerPatch.v1",
    file: path.basename(filePath),
    table: "FranchiseUser",
    tableId: table.header.tableId,
    tableUniqueId: table.header.uniqueId,
    row: record.index,
    recordSize: before.length,
    field: "AdminLevel",
    expectedBefore: labels[encodedBefore],
    value: "Owner",
    encoded: "00",
    bitOffset: 288,
    bitLength: 2,
    beforeHex: before.toString("hex"),
    afterHex: after.toString("hex"),
    changes,
  };
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
  const playerType = playerRecord.PlayerType || "";
  const physicalNames = physicalAbilityNames(playerType);
  const physicalRanks = [
    playerRecord.PhysicalAbility1 || "None",
    playerRecord.PhysicalAbility2 || "None",
    playerRecord.PhysicalAbility3 || "None",
    playerRecord.PhysicalAbility4 || "None",
    playerRecord.PhysicalAbility5 || "None",
  ];
  const mentalAbilities = [
    playerRecord.MentalAbility1 || "None",
    playerRecord.MentalAbility2 || "None",
    playerRecord.MentalAbility3 || "None",
  ];
  const mentalRanks = [
    playerRecord.MentalAbilityRank1 || "None",
    playerRecord.MentalAbilityRank2 || "None",
    playerRecord.MentalAbilityRank3 || "None",
  ];
  const dealbreaker = decodeDealbreaker(playerRecord.RecruitingDealbreaker);
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
    archetype: displayPlayerType(playerType),
    player_type: playerType,
    star_rating: decodeProspectStarRating(playerRecord.ProspectStarRating),
    star_rating_raw: playerRecord.ProspectStarRating || "",
    dev_trait: playerRecord.TraitDevelopment || "",
    dev_trait_display: displayDevelopmentTrait(playerRecord.TraitDevelopment),
    dealbreaker: dealbreaker.key,
    dealbreaker_display: dealbreaker.label,
    dealbreaker_raw: dealbreaker.raw,
    physical_traits: formatAbilityList(physicalNames, physicalRanks),
    physical_ability_1: physicalNames[0],
    physical_rank_1: physicalRanks[0],
    physical_ability_2: physicalNames[1],
    physical_rank_2: physicalRanks[1],
    physical_ability_3: physicalNames[2],
    physical_rank_3: physicalRanks[2],
    physical_ability_4: physicalNames[3],
    physical_rank_4: physicalRanks[3],
    physical_ability_5: physicalNames[4],
    physical_rank_5: physicalRanks[4],
    mental_traits: formatAbilityList(mentalAbilities.map(displayMentalAbility), mentalRanks),
    mental_ability_1: mentalAbilities[0],
    mental_rank_1: mentalRanks[0],
    mental_ability_2: mentalAbilities[1],
    mental_rank_2: mentalRanks[1],
    mental_ability_3: mentalAbilities[2],
    mental_rank_3: mentalRanks[2],
    jersey_number: Number(playerRecord.JerseyNum || 0),
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

function scoreFromRatings(values) {
  const numeric = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!numeric.length) return 0;
  const average = numeric.reduce((total, value) => total + value, 0) / numeric.length;
  return Number(Math.max(0, Math.min(1, average / 99)).toFixed(2));
}

function inferBodyComposition(height, weightLbs, position) {
  if (!height || !weightLbs) return "UNKNOWN";
  const inches = Number(height);
  const pounds = Number(weightLbs);
  const compactPositions = new Set(["HB", "CB", "FS", "SS", "WR", "K", "P"]);
  const bigPositions = new Set(["LT", "LG", "C", "RG", "RT", "DT"]);
  if (bigPositions.has(position) && pounds >= 285) return "MASS";
  if (compactPositions.has(position) && pounds <= 205) return "LEAN";
  if (inches >= 76 && pounds <= 230) return "LONG";
  if (pounds >= 245) return "POWER";
  return "BALANCED";
}

function inferProfileType(row) {
  const physical = scoreFromRatings([
    row.speed,
    row.acceleration,
    row.strength,
    row.agility,
    row.jumping,
  ]);
  const technical = scoreFromRatings([
    row.awareness,
    row.catching,
    row.tackle,
    row.throw_accuracy_short,
    row.run_block,
    row.pass_block,
  ]);
  if (physical >= 0.9 && technical < 0.72) return "RarePhysicalFreak";
  if (technical >= 0.82 && physical < 0.78) return "PolishedTechnician";
  if (row.national_rank > 0 && row.national_rank <= 300) return "BlueChipBalanced";
  return "Unassigned";
}

function rawRecruitFields(recruitRecord) {
  const result = {};
  for (const field of RESEARCH_FIELDS.Recruit) {
    const value = recruitRecord[field];
    if (value !== undefined) {
      result[field] = value;
    }
  }
  result.Player = recruitRecord.Player || "";
  return result;
}

function rawPlayerFields(playerRecord) {
  const result = {};
  const fields = [
    "FirstName",
    "LastName",
    "Height",
    "Weight",
    "Position",
    "JerseyNum",
    "TraitDevelopment",
    "RecruitingDealbreaker",
    "HomeState",
    "Hometown",
    "HomeTown",
    "CharacterVisuals",
    ...RESEARCH_FIELDS.Player,
    ...RATING_FIELDS.map((field) => field[3]),
  ];
  for (const field of fields) {
    const value = playerRecord[field];
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function joinedProfileFromPair(pair) {
  const { recruitRecord, recruitIndex, playerRecord, playerIndex } = pair;
  const row = rowFromPair(pair);
  const ratings = {};
  for (const [key] of RATING_FIELDS) {
    ratings[key] = row[key];
  }
  const physicalScore = scoreFromRatings([
    row.speed,
    row.acceleration,
    row.strength,
    row.agility,
    row.jumping,
  ]);
  const technicalScore = scoreFromRatings([
    row.awareness,
    row.catching,
    row.short_route_running,
    row.medium_route_running,
    row.deep_route_running,
    row.throw_accuracy_short,
    row.throw_accuracy_mid,
    row.throw_accuracy_deep,
    row.run_block,
    row.pass_block,
    row.tackle,
    row.man_coverage,
    row.zone_coverage,
  ]);
  const mentalScore = scoreFromRatings([row.awareness, row.play_recognition, row.toughness]);
  const readinessScore = scoreFromRatings([row.overall]);
  const ceilingScore = scoreFromRatings([
    row.overall,
    row.speed,
    row.acceleration,
    row.strength,
    row.throw_power,
    row.jumping,
  ]);
  const profileType = inferProfileType(row);
  return {
    recruitId: `Recruit:${recruitIndex}`,
    playerId: `Player:${playerIndex}`,
    source: {
      recruitRow: recruitIndex,
      playerRow: playerIndex,
      saveFingerprint: "",
    },
    identity: {
      firstName: row.first_name,
      lastName: row.last_name,
      homeState: playerRecord.HomeState || "",
      hometown: playerRecord.Hometown || playerRecord.HomeTown || "",
    },
    footballProfile: {
      nationalRank: row.national_rank,
      positionRank: row.position_rank,
      stateRank: row.state_rank,
      position: row.position,
      archetype: row.player_type,
      archetypeDisplay: row.archetype,
      profileType,
      readinessScore,
      physicalScore,
      technicalScore,
      mentalScore,
      ceilingScore,
      evaluationConfidence: row.national_rank > 0 ? 0.75 : 0.5,
      bodyComposition: inferBodyComposition(row.height_inches, row.weight_lbs, row.position),
    },
    gameFields: {
      ratings,
      developmentTrait: row.dev_trait,
      qualityModifier: recruitRecord.QualityModifier || "",
      starRating: decodeProspectStarRating(playerRecord.ProspectStarRating),
      starRatingRaw: playerRecord.ProspectStarRating || "",
      bodyType: playerRecord.CharacterBodyType || "",
      dealbreaker: row.dealbreaker,
      jerseyNumber: row.jersey_number,
      heightInches: row.height_inches,
      weightLbs: row.weight_lbs,
      appearanceToken: {
        genericHeadAssetName: row.generic_head_asset_name,
        genericHead: row.generic_head,
        portrait: playerRecord.PLYR_PORTRAIT || "",
        characterVisualsRef: row.character_visuals_ref,
      },
      generatedWrites: {},
    },
    locks: {
      rowLocked: false,
      fields: [],
    },
    generationIntent: {
      profileType,
      writePlan: {},
      notes: [],
    },
    originalFields: {
      Recruit: rawRecruitFields(recruitRecord),
      Player: rawPlayerFields(playerRecord),
    },
  };
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

async function joinedRecruitProfiles(filePath, limit, offset) {
  const franchise = await loadFranchise(filePath);
  const { recruitTable, playerTable } = await readRecruitResearchTables(franchise);
  const pairs = [];
  const unresolvedLinks = [];
  const skippedUnpatchableLinks = [];
  const linkedRecruitRowsByPlayer = new Map();
  let activeRecruitRows = 0;

  for (let index = 0; index < recruitTable.records.length; index += 1) {
    const recruitRecord = recruitTable.records[index];
    if (!recruitRecord || recruitRecord.isEmpty) continue;
    activeRecruitRows += 1;

    const ref = getReference(recruitRecord.Player);
    const playerRecord =
      ref && ref.tableId === playerTable.header.tableId
        ? playerTable.records[ref.rowNumber]
        : null;
    if (!ref || !playerRecord || playerRecord.isEmpty) {
      unresolvedLinks.push({
        recruitRow: index,
        playerReference: recruitRecord.Player || "",
      });
      continue;
    }

    const pair = recruitPlayerPair(recruitRecord, index, playerTable);
    if (!pair) {
      skippedUnpatchableLinks.push({
        recruitRow: index,
        playerReference: recruitRecord.Player || "",
        reason: "linked player row is not patchable",
      });
      continue;
    }

    const recruitRows = linkedRecruitRowsByPlayer.get(ref.rowNumber) || [];
    recruitRows.push(index);
    linkedRecruitRowsByPlayer.set(ref.rowNumber, recruitRows);
    pairs.push(pair);
  }

  const sharedPlayerLinks = [];
  for (const [playerRow, recruitRows] of linkedRecruitRowsByPlayer.entries()) {
    if (recruitRows.length > 1) {
      sharedPlayerLinks.push({ playerRow, recruitRows });
    }
  }
  if (unresolvedLinks.length || sharedPlayerLinks.length) {
    throw new Error(
      `Joined recruit profile validation failed: ${unresolvedLinks.length} unresolved links, `
        + `${sharedPlayerLinks.length} duplicate player links`,
    );
  }

  const profiles = pairs.map(joinedProfileFromPair);
  profiles.sort((a, b) => {
    const rankA = a.footballProfile.nationalRank > 0
      ? a.footballProfile.nationalRank
      : Number.MAX_SAFE_INTEGER;
    const rankB = b.footballProfile.nationalRank > 0
      ? b.footballProfile.nationalRank
      : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return `${a.identity.lastName} ${a.identity.firstName}`.localeCompare(
      `${b.identity.lastName} ${b.identity.firstName}`,
    );
  });
  const start = Math.max(0, offset || 0);
  const stop = Math.min(profiles.length, start + Math.max(1, Math.min(limit || 1000, 7600)));
  return {
    count: profiles.length,
    activeRecruitRows,
    offset: start,
    limit,
    recruits: profiles.slice(start, stop),
    validation: {
      unresolvedLinkCount: unresolvedLinks.length,
      sharedPlayerLinkCount: sharedPlayerLinks.length,
      skippedUnpatchableLinkCount: skippedUnpatchableLinks.length,
      skippedUnpatchableLinks: skippedUnpatchableLinks.slice(0, 25),
      passed: true,
    },
    warnings: skippedUnpatchableLinks.length
      ? [`Skipped ${skippedUnpatchableLinks.length} linked recruit row(s) that are not patchable`]
      : [],
  };
}

function recordObservedValue(summary, field, value, sample) {
  if (value === undefined || value === null || value === "") return;
  const key = String(value);
  if (!summary[field]) {
    summary[field] = { count: 0, values: {} };
  }
  const fieldSummary = summary[field];
  fieldSummary.count += 1;
  if (!fieldSummary.values[key]) {
    fieldSummary.values[key] = { count: 0, samples: [] };
  }
  const valueSummary = fieldSummary.values[key];
  valueSummary.count += 1;
  if (valueSummary.samples.length < 5) {
    valueSummary.samples.push(sample);
  }
}

function hasReadableField(table, field) {
  return table.records.some((record) => (
    record
    && !record.isEmpty
    && field in record
  ));
}

function researchFieldAvailability(recruitTable, playerTable, observedValues) {
  const availability = {};
  for (const [tableName, table, fields] of [
    ["Recruit", recruitTable, RESEARCH_FIELDS.Recruit],
    ["Player", playerTable, RESEARCH_FIELDS.Player],
  ]) {
    for (const field of fields) {
      const qualified = `${tableName}.${field}`;
      const observed = observedValues[qualified];
      const observedValueCount = observed ? observed.count : 0;
      availability[qualified] = {
        table: tableName,
        field,
        available: hasReadableField(table, field) || observedValueCount > 0,
        observedValueCount,
        distinctValueCount: observed ? Object.keys(observed.values).length : 0,
      };
    }
  }
  return availability;
}

async function researchRecruitFields(filePath, sampleLimit) {
  const franchise = await loadFranchise(filePath);
  const { recruitTable, playerTable } = await readRecruitResearchTables(franchise);
  const observedValues = {};
  const unresolvedLinks = [];
  const skippedUnpatchableLinks = [];
  const linkedRecruitRowsByPlayer = new Map();
  let activeRecruitRows = 0;
  let validLinks = 0;

  for (let index = 0; index < recruitTable.records.length; index += 1) {
    const recruitRecord = recruitTable.records[index];
    if (!recruitRecord || recruitRecord.isEmpty) continue;
    activeRecruitRows += 1;

    const ref = getReference(recruitRecord.Player);
    const playerRecord =
      ref && ref.tableId === playerTable.header.tableId
        ? playerTable.records[ref.rowNumber]
        : null;

    const pair = ref && playerRecord && !playerRecord.isEmpty
      ? recruitPlayerPair(recruitRecord, index, playerTable)
      : null;

    if (!ref || !playerRecord || playerRecord.isEmpty) {
      unresolvedLinks.push({
        recruitRow: index,
        playerReference: recruitRecord.Player || "",
        reason: "missing linked player row",
      });
      continue;
    }
    if (!pair) {
      skippedUnpatchableLinks.push({
        recruitRow: index,
        playerReference: recruitRecord.Player || "",
        reason: "linked player row is not patchable",
      });
      continue;
    }

    validLinks += 1;
    const playerRows = linkedRecruitRowsByPlayer.get(ref.rowNumber) || [];
    playerRows.push(index);
    linkedRecruitRowsByPlayer.set(ref.rowNumber, playerRows);

    if (sampleLimit && validLinks > sampleLimit) continue;
    const sample = {
      recruitRow: index,
      playerRow: ref.rowNumber,
      name: `${playerRecord.FirstName || ""} ${playerRecord.LastName || ""}`.trim(),
      position: playerRecord.Position || "",
      nationalRank: Number(recruitRecord.NationalRank || 0),
    };

    for (const field of RESEARCH_FIELDS.Recruit) {
      recordObservedValue(observedValues, `Recruit.${field}`, recruitRecord[field], sample);
    }
    for (const field of RESEARCH_FIELDS.Player) {
      recordObservedValue(observedValues, `Player.${field}`, playerRecord[field], sample);
    }
  }

  const sharedPlayerLinks = [];
  for (const [playerRow, recruitRows] of linkedRecruitRowsByPlayer.entries()) {
    if (recruitRows.length > 1) {
      sharedPlayerLinks.push({ playerRow, recruitRows });
    }
  }

  const fieldAvailability = researchFieldAvailability(recruitTable, playerTable, observedValues);
  const missingFields = Object.entries(fieldAvailability)
    .filter(([, item]) => !item.available)
    .map(([field]) => field);

  return {
    file: path.basename(filePath),
    gates: {
      "RG-1": {
        activeRecruitRows,
        validLinks,
        unresolvedLinkCount: unresolvedLinks.length,
        sharedPlayerLinkCount: sharedPlayerLinks.length,
        skippedUnpatchableLinkCount: skippedUnpatchableLinks.length,
        passed: unresolvedLinks.length === 0 && sharedPlayerLinks.length === 0,
        unresolvedLinks: unresolvedLinks.slice(0, 25),
        sharedPlayerLinks: sharedPlayerLinks.slice(0, 25),
        skippedUnpatchableLinks: skippedUnpatchableLinks.slice(0, 25),
      },
    },
    fieldAvailability,
    missingFields,
    observedValues,
  };
}

async function readRecruitingDiffTables(franchise) {
  const tables = {};
  for (const name of RECRUITING_DIFF_TABLES) {
    const table = franchise.getTableByName(name);
    if (!table) {
      tables[name] = null;
      continue;
    }
    await table.readRecords();
    tables[name] = table;
  }
  return tables;
}

function tableNameById(tables, franchise) {
  const result = {};
  if (franchise && franchise.tables) {
    for (const table of Object.values(franchise.tables)) {
      if (table && table.header && table.header.tableId !== undefined) {
        result[String(table.header.tableId)] = table.header.name || table.name || null;
      }
    }
  }
  for (const [name, table] of Object.entries(tables)) {
    if (table && table.header) {
      result[String(table.header.tableId)] = name;
    }
  }
  return result;
}

function referenceValue(value, tableNamesById) {
  if (typeof value === "string" && /^[01]+$/.test(value) && !/[1]/.test(value)) return null;
  const ref = getReference(value);
  if (!ref) return null;
  if (ref.tableId === 0 && ref.rowNumber === 0) return null;
  return {
    tableId: ref.tableId,
    table: tableNamesById[String(ref.tableId)] || null,
    row: ref.rowNumber,
  };
}

function tableById(franchise, tableId) {
  if (!franchise || !franchise.tables) return null;
  return Object.values(franchise.tables).find((table) => (
    table && table.header && table.header.tableId === tableId
  )) || null;
}

function recordFieldNames(record) {
  if (!record || !record._fields) return [];
  return Object.keys(record._fields);
}

function serializableValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

function serializeRecord(record, tableNamesById) {
  if (!record || record.isEmpty) return null;
  const fields = {};
  const references = {};
  for (const field of recordFieldNames(record)) {
    const value = serializableValue(record[field]);
    fields[field] = value;
    const schemaField = record._fields ? record._fields[field] : null;
    const isReference = schemaField && schemaField._offset && schemaField._offset.isReference;
    const ref = isReference && typeof value === "string" ? referenceValue(value, tableNamesById) : null;
    if (ref) references[field] = ref;
  }
  return { fields, references };
}

function fieldMetadata(record) {
  const result = {};
  if (!record || !record._fields) return result;
  for (const field of recordFieldNames(record)) {
    const offset = record._fields[field] && record._fields[field]._offset;
    if (!offset) continue;
    result[field] = {
      type: offset.type || null,
      isReference: Boolean(offset.isReference),
      offset: offset.offset,
      indexOffset: offset.indexOffset,
      length: offset.length,
      minValue: Number.isFinite(offset.minValue) ? offset.minValue : null,
      maxValue: Number.isFinite(offset.maxValue) ? offset.maxValue : null,
    };
  }
  return result;
}

function tableSnapshot(table, tableNamesById, tableName) {
  if (!table) {
    return {
      present: false,
      tableId: null,
      rowCount: 0,
      nonEmptyCount: 0,
      rows: {},
    };
  }
  const rows = {};
  let nonEmptyCount = 0;
  for (let index = 0; index < table.records.length; index += 1) {
    const record = serializeRecord(table.records[index], tableNamesById);
    if (!record) continue;
    if (tableName === "ProspectInteraction") {
      record.rawHex = table.records[index]._data ? table.records[index]._data.toString("hex") : null;
      record.fieldMetadata = fieldMetadata(table.records[index]);
    }
    nonEmptyCount += 1;
    rows[String(index)] = record;
  }
  return {
    present: true,
    tableId: table.header.tableId,
    rowCount: table.records.length,
    nonEmptyCount,
    rows,
  };
}

function diffRecords(before, after) {
  const beforeFields = before ? before.fields : {};
  const afterFields = after ? after.fields : {};
  const fieldNames = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  const changes = {};
  for (const field of fieldNames) {
    const beforeValue = beforeFields[field];
    const afterValue = afterFields[field];
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changes[field] = { before: beforeValue ?? null, after: afterValue ?? null };
    }
  }
  return changes;
}

function diffRecordDetails(record) {
  if (!record) return null;
  const details = {
    fields: record.fields || {},
    references: record.references || {},
  };
  if (record.rawHex) details.rawHex = record.rawHex;
  if (record.fieldMetadata) details.fieldMetadata = record.fieldMetadata;
  return details;
}

function changedFieldReferenceDetails(beforeRecord, afterRecord, fields) {
  const details = {};
  for (const field of fields) {
    const beforeReference = beforeRecord && beforeRecord.references
      ? beforeRecord.references[field] || null
      : null;
    const afterReference = afterRecord && afterRecord.references
      ? afterRecord.references[field] || null
      : null;
    if (beforeReference || afterReference) {
      details[field] = {
        before: beforeReference,
        after: afterReference,
      };
    }
  }
  return details;
}

function byteDiffs(beforeHex, afterHex) {
  if (!beforeHex || !afterHex) return [];
  const beforeBuffer = Buffer.from(beforeHex, "hex");
  const afterBuffer = Buffer.from(afterHex, "hex");
  const stop = Math.max(beforeBuffer.length, afterBuffer.length);
  const diffs = [];
  for (let index = 0; index < stop; index += 1) {
    const beforeByte = beforeBuffer[index] ?? null;
    const afterByte = afterBuffer[index] ?? null;
    if (beforeByte !== afterByte) {
      diffs.push({
        byte: index,
        before: beforeByte,
        after: afterByte,
        beforeHex: beforeByte === null ? null : beforeByte.toString(16).padStart(2, "0"),
        afterHex: afterByte === null ? null : afterByte.toString(16).padStart(2, "0"),
        xor: beforeByte === null || afterByte === null ? null : beforeByte ^ afterByte,
      });
    }
  }
  return diffs;
}

function binaryStringChange(beforeValue, afterValue) {
  if (
    typeof beforeValue !== "string"
    || typeof afterValue !== "string"
    || !/^[01]+$/.test(beforeValue)
    || !/^[01]+$/.test(afterValue)
    || beforeValue.length !== afterValue.length
  ) {
    return null;
  }
  const changedBitPositionsFromLeft = [];
  const changedBitPositionsLsb0 = [];
  for (let index = 0; index < beforeValue.length; index += 1) {
    if (beforeValue[index] !== afterValue[index]) {
      changedBitPositionsFromLeft.push(index);
      changedBitPositionsLsb0.push(beforeValue.length - 1 - index);
    }
  }
  return {
    before: beforeValue,
    after: afterValue,
    changedBitPositionsFromLeft,
    changedBitPositionsLsb0,
  };
}

function analyzeProspectInteractionChange(beforeRecord, afterRecord, changes) {
  const changedFields = Object.keys(changes);
  const rawByteDiffs = byteDiffs(beforeRecord && beforeRecord.rawHex, afterRecord && afterRecord.rawHex);
  const fieldMetadataByName = afterRecord && afterRecord.fieldMetadata
    ? afterRecord.fieldMetadata
    : (beforeRecord && beforeRecord.fieldMetadata ? beforeRecord.fieldMetadata : {});
  const binaryFieldDiffs = {};
  for (const field of changedFields) {
    const diff = binaryStringChange(changes[field].before, changes[field].after);
    if (diff) binaryFieldDiffs[field] = diff;
  }
  const visitFieldsChanged = changedFields.includes("VisitActivityType") || changedFields.includes("VisitWeekType");
  const unlockedIntelOnlyByte =
    rawByteDiffs.length === 1
    && rawByteDiffs[0].byte === 11
    && rawByteDiffs[0].before === 0
    && rawByteDiffs[0].after === 16
    && changes.UnlockedIntelBitfield
    && changes.UnlockedIntelBitfield.before === 0
    && changes.UnlockedIntelBitfield.after === 16;
  return {
    changedFields,
    rawByteDiffs,
    fieldMetadata: Object.fromEntries(
      changedFields.map((field) => [field, fieldMetadataByName[field] || null]),
    ),
    binaryFieldDiffs,
    conclusion: visitFieldsChanged && unlockedIntelOnlyByte
      ? "VisitActivityType and VisitWeekType changed only because madden-franchise exposes adjacent enum/reference bit windows; the only byte-level row change is UnlockedIntelBitfield 0 -> 16. This is not independent visit-scheduling evidence in this fixture."
      : "No overlap conclusion; requires isolated fixture evidence.",
  };
}

function diffTableSnapshots(name, before, after) {
  const beforeRows = before.rows || {};
  const afterRows = after.rows || {};
  const rowIds = new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)]);
  const addedRows = [];
  const addedRowDetails = [];
  const removedRows = [];
  const removedRowDetails = [];
  const changedRows = [];
  const fieldChangeCounts = {};

  for (const rowId of rowIds) {
    const beforeRecord = beforeRows[rowId] || null;
    const afterRecord = afterRows[rowId] || null;
    if (!beforeRecord && afterRecord) {
      const row = Number(rowId);
      addedRows.push(row);
      addedRowDetails.push({ row, ...diffRecordDetails(afterRecord) });
      continue;
    }
    if (beforeRecord && !afterRecord) {
      const row = Number(rowId);
      removedRows.push(row);
      removedRowDetails.push({ row, ...diffRecordDetails(beforeRecord) });
      continue;
    }
    const changes = diffRecords(beforeRecord, afterRecord);
    const fields = Object.keys(changes);
    if (!fields.length) continue;
    for (const field of fields) {
      fieldChangeCounts[field] = (fieldChangeCounts[field] || 0) + 1;
    }
    const fieldReferences = changedFieldReferenceDetails(beforeRecord, afterRecord, fields);
    const rowChange = {
      row: Number(rowId),
      fieldCount: fields.length,
      fields: changes,
    };
    if (Object.keys(fieldReferences).length) {
      rowChange.fieldReferences = fieldReferences;
    }
    changedRows.push(rowChange);
  }

  changedRows.sort((a, b) => a.row - b.row);
  addedRows.sort((a, b) => a - b);
  addedRowDetails.sort((a, b) => a.row - b.row);
  removedRows.sort((a, b) => a - b);
  removedRowDetails.sort((a, b) => a.row - b.row);
  return {
    name,
    tableId: after.tableId || before.tableId || null,
    presentBefore: before.present,
    presentAfter: after.present,
    beforeRowCount: before.rowCount,
    afterRowCount: after.rowCount,
    beforeNonEmptyRows: before.nonEmptyCount,
    afterNonEmptyRows: after.nonEmptyCount,
    addedRowCount: addedRows.length,
    removedRowCount: removedRows.length,
    changedRowCount: changedRows.length,
    fieldChangeCounts,
    addedRows: addedRows.slice(0, 50),
    addedRowDetails: addedRowDetails.slice(0, 25),
    removedRows: removedRows.slice(0, 50),
    removedRowDetails: removedRowDetails.slice(0, 25),
    changedRows: changedRows.slice(0, 50),
  };
}

function fieldsFor(snapshot, tableName, row) {
  const table = snapshot.tables[tableName];
  const record = table && table.rows[String(row)];
  return record ? record.fields : null;
}

function referenceFor(snapshot, tableName, row, field) {
  const table = snapshot.tables[tableName];
  const record = table && table.rows[String(row)];
  return record && record.references ? record.references[field] || null : null;
}

function firstProspectInteractionForRecruit(snapshot, recruitRow) {
  const table = snapshot.tables.ProspectInteraction;
  if (!table) return [];
  const rows = [];
  for (const [rowId, record] of Object.entries(table.rows)) {
    const ref = record.references ? record.references.Recruit : null;
    if (ref && ref.table === "Recruit" && ref.row === recruitRow) {
      rows.push(Number(rowId));
    }
  }
  rows.sort((a, b) => a - b);
  return rows;
}

function activeVisitInfoState(snapshot, ref) {
  if (!ref || ref.table !== "ActiveVisitInfo") return null;
  const fields = fieldsFor(snapshot, "ActiveVisitInfo", ref.row);
  if (!fields) return null;
  return {
    row: ref.row,
    activity: fields.Activity ?? null,
    weekType: fields.WeekType ?? null,
    weekNumber: fields.WeekNumber ?? null,
    fields,
  };
}

function activePitchesState(snapshot, ref) {
  if (!ref || ref.table !== "ActiveRecruitingPitch[]") return [];
  const listRecord = snapshot.tables["ActiveRecruitingPitch[]"]
    && snapshot.tables["ActiveRecruitingPitch[]"].rows[String(ref.row)];
  if (!listRecord) return [];
  const pitches = [];
  for (const [field, pitchRef] of Object.entries(listRecord.references || {})) {
    if (!pitchRef || pitchRef.table !== "ActiveRecruitingPitch") continue;
    const pitchFields = fieldsFor(snapshot, "ActiveRecruitingPitch", pitchRef.row);
    pitches.push({
      field,
      row: pitchRef.row,
      intensity: pitchFields ? pitchFields.Intensity ?? null : null,
      pitch: pitchFields ? pitchFields.Pitch ?? null : null,
    });
  }
  pitches.sort((a, b) => a.field.localeCompare(b.field, undefined, { numeric: true }));
  return pitches;
}

function boardRowsReferencingRecruitTarget(snapshot, recruitTargetRow) {
  return (snapshot.boardRows || [])
    .filter((board) => (
      board.recruitsList
      && Array.isArray(board.recruitsList.recruitTargetRows)
      && board.recruitsList.recruitTargetRows.includes(recruitTargetRow)
    ))
    .map((board) => board.row)
    .sort((a, b) => a - b);
}

function sameRecruitTargetActivePitchEvidence(snapshot, recruitRow) {
  if (recruitRow === null || recruitRow === undefined) return [];
  const table = snapshot.tables.RecruitTarget;
  if (!table) return [];
  const rows = [];
  for (const [rowId, record] of Object.entries(table.rows || {})) {
    const recruitRef = record.references ? record.references.Recruit : null;
    if (!recruitRef || recruitRef.table !== "Recruit" || recruitRef.row !== recruitRow) continue;
    const activePitchesRef = record.references ? record.references.ActivePitches || null : null;
    const activePitches = activePitchesState(snapshot, activePitchesRef);
    if (!activePitches.length) continue;
    const row = Number(rowId);
    rows.push({
      recruitTargetRow: row,
      activePitchesRef,
      activePitches,
      referencingBoardRows: boardRowsReferencingRecruitTarget(snapshot, row),
      ownershipStatus: "ambiguous-read-only",
      note: "RecruitTarget rows do not expose a safe team/school owner field in this schema; do not use as a write target.",
    });
  }
  rows.sort((a, b) => a.recruitTargetRow - b.recruitTargetRow);
  return rows;
}

function displayName(playerFields) {
  if (!playerFields) return "";
  return `${playerFields.FirstName || ""} ${playerFields.LastName || ""}`.trim();
}

function selectedActions(fields) {
  if (!fields) return { labels: [], hours: 0 };
  const labels = [];
  let hours = 0;
  for (const [field, cost] of Object.entries(WEEKLY_ACTION_HOURS)) {
    if (fields[field] === true) {
      labels.push(field);
      hours += cost;
    }
  }
  return { labels, hours };
}

function hasScholarshipOffer(status) {
  return Boolean(status && status !== "None");
}

function scholarshipLabel(status) {
  return hasScholarshipOffer(status) ? "Offered" : "None";
}

function firstUserBoard(snapshot) {
  const boards = (snapshot.boardRows || [])
    .filter((board) => board && board.recruitsList && board.recruitsList.userRecruitTargetRows.length)
    .sort((left, right) => {
      const leftCount = left.recruitsList.userRecruitTargetRows.length;
      const rightCount = right.recruitsList.userRecruitTargetRows.length;
      if (leftCount !== rightCount) return rightCount - leftCount;
      return left.row - right.row;
    });
  return boards[0] || null;
}

function recruitingWriteGates() {
  return {
    actions: "preview-only-existing-action-fields; apply blocked by 017 MVP",
    scouting: "blocked-by-true-scouting-grade-evidence",
    offers: "preview-only; copy-write still gated",
    visitsAndPitches: "existing-active-pitch pitch/intensity validated by 016; forced allocation blocked",
    forcedActivePitchAllocation: "blocked-by-load-failure",
  };
}

function recruitingFieldCapabilities() {
  return [
    {
      field: "UserRecruitTarget.SearchSocialMedia",
      state: "preview-only",
      evidence: "015 action-hour fixtures",
    },
    {
      field: "UserRecruitTarget.ContactHighSchoolCoaches",
      state: "preview-only",
      evidence: "015 action-hour fixtures",
    },
    {
      field: "UserRecruitTarget.ContactFriendsAndFamily",
      state: "preview-only",
      evidence: "015 action-hour fixtures",
    },
    {
      field: "UserRecruitTarget.SendTheHouse",
      state: "preview-only",
      evidence: "015 action-hour fixtures",
    },
    {
      field: "UserRecruitTarget.ScholarshipStatus",
      state: "preview-only",
      evidence: "015 offer fixtures; apply still gated by 017 MVP",
    },
    {
      field: "ActiveRecruitingPitch.Pitch",
      state: "validated-existing-row-preview-only",
      evidence: "016 natural active-pitch row load/week-survival chain",
    },
    {
      field: "ActiveRecruitingPitch.Intensity",
      state: "validated-existing-row-preview-only",
      evidence: "016 pitch-only, Hard Sell, and Sway probes",
    },
    {
      field: "ActiveRecruitingPitch[] allocation",
      state: "unsafe",
      evidence: "016 seeded allocation parsed locally but failed game load",
    },
  ];
}

function recruitingTargetFromState(state, boardRow) {
  const profile = state.recruitingProfile || {};
  const maxHours = state.activePitches && state.activePitches.length ? 60 : 50;
  const ambiguousPitchEvidence = (state.sameRecruitTargetActivePitches || []).slice(0, 5).map((item) => ({
    recruitTargetRow: item.recruitTargetRow,
    activePitchesRef: item.activePitchesRef,
    activePitches: item.activePitches,
    referencingBoardRows: item.referencingBoardRows,
    ownershipStatus: item.ownershipStatus,
  }));
  return {
    id: `UserRecruitTarget:${state.userRecruitTargetRow}`,
    boardRow,
    name: state.name,
    position: state.position,
    stars: state.stars,
    nationalRank: state.nationalRank,
    positionRank: state.positionRank,
    stateRank: state.stateRank,
    stage: "Active Board",
    interestRank: null,
    scoutingPercent: null,
    offerState: scholarshipLabel(state.scholarshipStatus),
    activeHours: state.selectedActionHours,
    maxHours,
    selectedActions: state.selectedActions,
    actionBooleans: state.actionBooleans,
    activePitches: state.activePitches,
    scholarshipStatus: state.scholarshipStatus,
    scholarshipBonus: state.scholarshipBonus,
    currentNilOffer: state.currentNilOffer,
    nilExpectation: state.nilExpectation,
    archetype: state.archetype,
    heightInches: state.heightInches,
    heightDisplay: state.heightDisplay,
    weightLbs: state.weightLbs,
    homeState: state.homeState,
    hometown: state.hometown,
    isFavorite: state.isFavorite,
    prospectInfluenceTotal: state.prospectInfluenceTotal,
    prospectHoursSpentCurrent: state.prospectHoursSpentCurrent,
    recruitingProfile: profile,
    visit: compactVisitState(state),
    prospectInteractions: (state.prospectInteractions || []).map((interaction) => ({
      row: interaction.row,
      fields: {
        IsVisitScheduled: interaction.fields ? interaction.fields.IsVisitScheduled ?? null : null,
        VisitWeekNumber: interaction.fields ? interaction.fields.VisitWeekNumber ?? null : null,
        HasOfferedScholarship: interaction.fields ? interaction.fields.HasOfferedScholarship ?? null : null,
        TimesScouted: interaction.fields ? interaction.fields.TimesScouted ?? null : null,
        UnlockedIntelBitfield: interaction.fields ? interaction.fields.UnlockedIntelBitfield ?? null : null,
      },
    })),
    provenance: {
      recruitRow: state.recruitRow,
      playerRow: state.playerRow,
      userRecruitTargetRow: state.userRecruitTargetRow,
      prospectInteractionRows: state.prospectInteractionRows,
      activePitchesRef: state.activePitchesRef,
      activePitchRows: (state.activePitches || []).map((pitch) => pitch.row),
      sameRecruitTargetActivePitches: ambiguousPitchEvidence,
      sameRecruitTargetActivePitchCount: (state.sameRecruitTargetActivePitches || []).length,
      boardRow,
      confidence: {
        board: "high-for-current-save",
        profile: state.recruitRow !== null && state.playerRow !== null ? "high" : "missing-link",
        counters: "derived-from-board-and-selected-actions",
      },
    },
  };
}

async function recruitingWorkbenchBoard(filePath) {
  const snapshot = await recruitingSnapshot(filePath, path.basename(filePath));
  const board = firstUserBoard(snapshot);
  const userRows = board && board.recruitsList
    ? board.recruitsList.userRecruitTargetRows
    : Object.keys((snapshot.tables.UserRecruitTarget && snapshot.tables.UserRecruitTarget.rows) || {})
      .map((row) => Number(row))
      .sort((left, right) => left - right);
  const targetStates = userRows
    .map((row) => userRecruitTargetState(snapshot, row))
    .filter(Boolean);
  const targets = targetStates.map((target) => recruitingTargetFromState(target, board ? board.row : null));
  const selectedHours = targets.reduce((total, target) => total + Number(target.activeHours || 0), 0);
  const scholarshipsUsed = targets.filter((target) => hasScholarshipOffer(target.scholarshipStatus)).length;
  const hoursMax = board ? Number(board.recruitingHoursTotal || 0) : null;
  const hoursRemaining = board && board.recruitingHoursAssigned !== null
    ? Number(board.recruitingHoursAssigned || 0)
    : (hoursMax === null ? null : Math.max(0, hoursMax - selectedHours));
  return {
    kind: "cfb27.recruitingWorkbench.v1",
    saveName: path.basename(filePath),
    readOnly: true,
    phase: "unknown",
    boardRow: board ? board.row : null,
    board,
    writeGates: recruitingWriteGates(),
    fieldCapabilities: recruitingFieldCapabilities(),
    counters: {
      remainingPoints: hoursRemaining,
      targetsUsed: targets.length,
      targetsMax: 35,
      hoursUsed: selectedHours,
      hoursMax,
      scholarshipsUsed,
      scholarshipsMax: 35,
      boardVisibleHoursUsed: board ? board.derivedVisibleHoursUsed : null,
      boardRecruitingHoursAssigned: board ? board.recruitingHoursAssigned : null,
      boardRecruitingHoursProcessed: board ? board.recruitingHoursProcessed : null,
    },
    targets,
    warnings: board
      ? []
      : ["No RecruitingBoard row referencing UserRecruitTarget rows was found; showing all UserRecruitTarget rows."],
  };
}

function hasScheduledVisitState(state) {
  if (!state) return false;
  if (state.scheduledVisit) return true;
  return Boolean(state.prospectVisitState && state.prospectVisitState.isVisitScheduled);
}

function compactVisitState(state) {
  if (!state) return null;
  return {
    scheduledVisitRef: state.scheduledVisitRef || null,
    scheduledVisit: state.scheduledVisit
      ? {
        row: state.scheduledVisit.row,
        activity: state.scheduledVisit.activity,
        weekType: state.scheduledVisit.weekType,
        weekNumber: state.scheduledVisit.weekNumber,
      }
      : null,
    visitRecruitsSchool: state.visitRecruitsSchool ?? null,
    prospectVisitState: state.prospectVisitState || null,
  };
}

function visitStateStatus(beforeState, afterState) {
  const beforeHasVisit = hasScheduledVisitState(beforeState);
  const afterHasVisit = hasScheduledVisitState(afterState);
  if (!beforeHasVisit && afterHasVisit) return "new";
  if (beforeHasVisit && !afterHasVisit) return "removed";
  if (beforeHasVisit && afterHasVisit) {
    const beforeVisitRow = beforeState.scheduledVisit ? beforeState.scheduledVisit.row : null;
    const afterVisitRow = afterState.scheduledVisit ? afterState.scheduledVisit.row : null;
    const beforeWeek = beforeState.scheduledVisit
      ? beforeState.scheduledVisit.weekNumber
      : (beforeState.prospectVisitState || {}).visitWeekNumber;
    const afterWeek = afterState.scheduledVisit
      ? afterState.scheduledVisit.weekNumber
      : (afterState.prospectVisitState || {}).visitWeekNumber;
    return beforeVisitRow === afterVisitRow && beforeWeek === afterWeek ? "unchanged" : "changed";
  }
  return "none";
}

function visitConsistency(state) {
  if (!state) {
    return {
      hasActiveVisitInfo: false,
      prospectInteractionScheduled: false,
      activeVisitWeekMatchesProspect: null,
      consistent: false,
    };
  }
  const scheduledVisit = state.scheduledVisit;
  const prospect = state.prospectVisitState || {};
  const hasActiveVisitInfo = Boolean(scheduledVisit);
  const prospectInteractionScheduled = Boolean(prospect.isVisitScheduled);
  const activeVisitWeekMatchesProspect = hasActiveVisitInfo && prospect.visitWeekNumber !== null && prospect.visitWeekNumber !== undefined
    ? scheduledVisit.weekNumber === prospect.visitWeekNumber
    : null;
  return {
    hasActiveVisitInfo,
    prospectInteractionScheduled,
    activeVisitWeekMatchesProspect,
    consistent: hasActiveVisitInfo && prospectInteractionScheduled && activeVisitWeekMatchesProspect === true,
  };
}

function userRecruitTargetState(snapshot, row) {
  const fields = fieldsFor(snapshot, "UserRecruitTarget", row);
  if (!fields) return null;
  const recruitRef = referenceFor(snapshot, "UserRecruitTarget", row, "Recruit");
  const recruitRow = recruitRef && recruitRef.table === "Recruit" ? recruitRef.row : null;
  const recruitFields = recruitRow !== null ? fieldsFor(snapshot, "Recruit", recruitRow) : null;
  const playerRef = recruitFields ? referenceValue(recruitFields.Player, snapshot.tableNamesById) : null;
  const playerRow = playerRef && playerRef.table === "Player" ? playerRef.row : null;
  const playerFields = playerRow !== null ? fieldsFor(snapshot, "Player", playerRow) : null;
  const scheduledVisitRef = referenceFor(snapshot, "UserRecruitTarget", row, "ScheduledVisit");
  const scheduledVisit = activeVisitInfoState(snapshot, scheduledVisitRef);
  const activePitchesRef = referenceFor(snapshot, "UserRecruitTarget", row, "ActivePitches");
  const activePitches = activePitchesState(snapshot, activePitchesRef);
  const prospectInteractionRows = recruitRow !== null
    ? firstProspectInteractionForRecruit(snapshot, recruitRow)
    : [];
  const primaryProspectInteraction = prospectInteractionRows.length
    ? fieldsFor(snapshot, "ProspectInteraction", prospectInteractionRows[0])
    : null;
  const actionState = selectedActions(fields);
  return {
    userRecruitTargetRow: row,
    recruitRow,
    playerRow,
    name: displayName(playerFields),
    position: playerFields ? playerFields.Position || "" : "",
    nationalRank: recruitFields ? Number(recruitFields.NationalRank || 0) : 0,
    positionRank: recruitFields ? Number(recruitFields.PositionRank || 0) : null,
    stateRank: recruitFields ? Number(recruitFields.StateRank || 0) : null,
    stars: playerFields ? prospectStarCount(playerFields.ProspectStarRating) : null,
    archetype: playerFields ? playerFields.PlayerType || "" : "",
    heightInches: playerFields ? Number(playerFields.Height || 0) : null,
    heightDisplay: playerFields ? heightDisplay(playerFields.Height) : "",
    weightLbs: playerFields ? poundsFromRaw(playerFields.Weight) : null,
    homeState: playerFields ? playerFields.HomeState || "" : "",
    hometown: playerFields ? playerFields.Hometown || playerFields.HomeTown || "" : "",
    recruitingProfile: playerFields
      ? {
        dealbreakerRaw: playerFields.RecruitingDealbreaker ?? null,
        idealPitchRaw: playerFields.IdealRecruitingPitch ?? null,
        motivation1Raw: playerFields.Motivation1 ?? null,
        motivation2Raw: playerFields.Motivation2 ?? null,
        motivation3Raw: playerFields.Motivation3 ?? null,
        productionGrade: recruitFields ? recruitFields.ProductionGrade ?? null : null,
      }
      : null,
    selectedActions: actionState.labels,
    selectedActionHours: actionState.hours,
    actionBooleans: Object.fromEntries(
      Object.keys(WEEKLY_ACTION_HOURS).map((field) => [field, fields[field] === true]),
    ),
    scholarshipStatus: fields.ScholarshipStatus ?? null,
    currentNilOffer: fields.CurrentNILOffer ?? null,
    nilExpectation: fields.NILExpectation ?? null,
    originalNilExpectation: fields.OriginalNILExpectation ?? null,
    scholarshipBonus: fields.CurrentScholarshipBonus ?? null,
    unlockedIntelBitfield: fields.UnlockedIntelBitfield ?? null,
    isFavorite: fields.IsFavorite ?? null,
    prospectInfluenceTotal: fields.ProspectInfluenceTotal ?? null,
    prospectHoursSpentCurrent: fields.ProspectHoursSpentCurrent ?? null,
    activePitchesRef,
    activePitches,
    sameRecruitTargetActivePitches: sameRecruitTargetActivePitchEvidence(snapshot, recruitRow),
    scheduledVisitRef,
    scheduledVisit,
    visitRecruitsSchool: fields.VisitRecruitsSchool ?? null,
    prospectVisitState: primaryProspectInteraction
      ? {
        isVisitScheduled: primaryProspectInteraction.IsVisitScheduled ?? null,
        visitActivityType: primaryProspectInteraction.VisitActivityType ?? null,
        visitWeekType: primaryProspectInteraction.VisitWeekType ?? null,
        visitWeekNumber: primaryProspectInteraction.VisitWeekNumber ?? null,
        hasOfferedScholarship: primaryProspectInteraction.HasOfferedScholarship ?? null,
      }
      : null,
    prospectInteractionRows,
    prospectInteractions: prospectInteractionRows.slice(0, 10).map((interactionRow) => ({
      row: interactionRow,
      fields: fieldsFor(snapshot, "ProspectInteraction", interactionRow),
    })),
  };
}

function boardTargetDiff(beforeSnapshot, afterSnapshot, row) {
  const before = userRecruitTargetState(beforeSnapshot, row);
  const after = userRecruitTargetState(afterSnapshot, row);
  const userTargetChanges = diffRecords(
    beforeSnapshot.tables.UserRecruitTarget.rows[String(row)] || null,
    afterSnapshot.tables.UserRecruitTarget.rows[String(row)] || null,
  );
  const beforeInteractionRows = before ? before.prospectInteractionRows : [];
  const afterInteractionRows = after ? after.prospectInteractionRows : [];
  const interactionRows = new Set([...beforeInteractionRows, ...afterInteractionRows]);
  const prospectInteractionChanges = [];
  for (const interactionRow of interactionRows) {
    const beforeRecord = beforeSnapshot.tables.ProspectInteraction.rows[String(interactionRow)] || null;
    const afterRecord = afterSnapshot.tables.ProspectInteraction.rows[String(interactionRow)] || null;
    const changes = diffRecords(
      beforeRecord,
      afterRecord,
    );
    if (Object.keys(changes).length) {
      prospectInteractionChanges.push({
        row: interactionRow,
        fields: changes,
        analysis: analyzeProspectInteractionChange(beforeRecord, afterRecord, changes),
      });
    }
  }
  return {
    row,
    name: (after && after.name) || (before && before.name) || "",
    before,
    after,
    userRecruitTargetChanges: userTargetChanges,
    prospectInteractionChanges,
  };
}

async function referencedListState(franchise, refValue, tableNamesById) {
  const listRef = referenceValue(refValue, tableNamesById);
  if (!listRef) return null;
  const listTable = tableById(franchise, listRef.tableId);
  if (!listTable) return { ...listRef, references: [] };
  await listTable.readRecords();
  const record = listTable.records[listRef.row];
  if (!record || record.isEmpty) return { ...listRef, references: [] };
  const references = [];
  for (const field of recordFieldNames(record)) {
    const schemaField = record._fields ? record._fields[field] : null;
    const isReference = schemaField && schemaField._offset && schemaField._offset.isReference;
    const ref = isReference ? referenceValue(record[field], tableNamesById) : null;
    if (ref) references.push({ field, ...ref });
  }
  return { ...listRef, references };
}

function stateForUserTargetReference(snapshot, ref) {
  if (!ref || ref.table !== "UserRecruitTarget") return null;
  return userRecruitTargetState(snapshot, ref.row);
}

function normalizedLookupKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[_:.-]/g, "").replace(/\s+/g, " ");
}

function activePitchPackedValue(record) {
  const raw = String(record.Intensity || "");
  if (raw && /^[01]{32}$/.test(raw)) return parseInt(raw, 2);
  const rawHex = record._data ? record._data.toString("hex") : "";
  if (rawHex) return parseInt(rawHex, 16);
  return 0;
}

function parseActivePitchComponent(value, field) {
  if (value === null || value === undefined) {
    throw new Error(`ActiveRecruitingPitch.${field} requires a value`);
  }
  const raw = String(value).trim();
  if (/^[01]+$/.test(raw)) return parseInt(raw, 2);
  if (/^\d+$/.test(raw)) return Number(raw);
  const label = raw.includes(":") ? raw.split(":").pop() : raw;
  const normalized = normalizedLookupKey(label);
  if (field === "Pitch") {
    if (ACTIVE_RECRUITING_PITCH_TYPES.has(normalized)) {
      return ACTIVE_RECRUITING_PITCH_TYPES.get(normalized);
    }
    throw new Error(`Unsupported ActiveRecruitingPitch.Pitch label: ${value}`);
  }
  if (ACTIVE_RECRUITING_PITCH_INTENSITIES.has(normalized)) {
    return ACTIVE_RECRUITING_PITCH_INTENSITIES.get(normalized);
  }
  throw new Error(`Unsupported ActiveRecruitingPitch.Intensity label: ${value}`);
}

function patchActiveRecruitingPitchValue(record, item) {
  const field = String(item.field || "");
  if (!["Pitch", "Intensity"].includes(field)) return null;
  const beforePacked = activePitchPackedValue(record);
  const beforePitch = beforePacked & 0x1F;
  const beforeIntensity = beforePacked >> 5;
  const component = parseActivePitchComponent(item.value, field);
  if (field === "Pitch" && (component < 0 || component > 31)) {
    throw new Error("ActiveRecruitingPitch.Pitch must fit in 5 bits");
  }
  if (field === "Intensity" && (component < 0 || component >= (1 << 27))) {
    throw new Error("ActiveRecruitingPitch.Intensity must fit in 27 bits");
  }
  const afterPacked = field === "Pitch"
    ? ((beforePacked & ~0x1F) | component)
    : ((component << 5) | beforePitch);
  const afterBinary = afterPacked.toString(2).padStart(32, "0");
  record.Intensity = afterBinary;
  return {
    before: field === "Pitch" ? beforePitch : beforeIntensity,
    after: field === "Pitch" ? (activePitchPackedValue(record) & 0x1F) : (activePitchPackedValue(record) >> 5),
    packedBefore: beforePacked.toString(2).padStart(32, "0"),
    packedAfter: afterBinary,
    pitchBefore: beforePitch,
    pitchAfter: activePitchPackedValue(record) & 0x1F,
    intensityBefore: beforeIntensity,
    intensityAfter: activePitchPackedValue(record) >> 5,
    encodedFrom: item.value,
  };
}

function patchFieldValue(franchise, liveTables, item) {
  const tableName = String(item.table || "");
  const row = Number(item.row);
  const field = String(item.field || "");
  if (!tableName || !field || !Number.isInteger(row) || row < 0) {
    throw new Error("Field patch requires table, row, and field");
  }
  const table = liveTables[tableName] || franchise.getTableByName(tableName);
  if (!table) {
    throw new Error(`Table is unavailable: ${tableName}`);
  }
  const record = table.records[row];
  if (!record || (record.isEmpty && !item.allowEmpty)) {
    throw new Error(`Cannot patch unavailable or empty record ${tableName}[${row}]`);
  }
  if (tableName === "ActiveRecruitingPitch" && ["Pitch", "Intensity"].includes(field)) {
    const packedChange = patchActiveRecruitingPitchValue(record, item);
    return {
      table: tableName,
      row,
      field,
      before: packedChange.before,
      after: packedChange.after,
      packedBefore: packedChange.packedBefore,
      packedAfter: packedChange.packedAfter,
      pitchBefore: packedChange.pitchBefore,
      pitchAfter: packedChange.pitchAfter,
      intensityBefore: packedChange.intensityBefore,
      intensityAfter: packedChange.intensityAfter,
      encodedFrom: packedChange.encodedFrom,
      resolvedFrom: item.resolvedFrom || null,
    };
  }
  const before = serializableValue(record[field]);
  let after;
  if (item.reference) {
    after = utilService.getBinaryReferenceData(Number(item.reference.tableId), Number(item.reference.row));
  } else {
    after = item.value;
  }
  record[field] = after;
  return {
    table: tableName,
    row,
    field,
    before,
    after: serializableValue(record[field]),
    resolvedFrom: item.resolvedFrom || null,
  };
}

async function resolveActivePitchFieldPatch(franchise, liveTables, item, tableNamesById) {
  if (String(item.table || "") !== "ActiveRecruitingPitch" || (item.row !== undefined && item.row !== null)) {
    return item;
  }
  const userRecruitTargetRow = Number(item.userRecruitTargetRow);
  const activePitchIndex = Number(item.activePitchIndex ?? 0);
  if (!Number.isInteger(userRecruitTargetRow) || userRecruitTargetRow < 0) {
    throw new Error("ActiveRecruitingPitch discovery requires userRecruitTargetRow");
  }
  if (!Number.isInteger(activePitchIndex) || activePitchIndex < 0) {
    throw new Error("ActiveRecruitingPitch discovery requires a non-negative activePitchIndex");
  }
  const targetTable = liveTables.UserRecruitTarget;
  if (!targetTable) throw new Error("UserRecruitTarget table is unavailable");
  const targetRecord = targetTable.records[userRecruitTargetRow];
  if (!targetRecord || targetRecord.isEmpty) {
    throw new Error(`UserRecruitTarget row ${userRecruitTargetRow} is unavailable`);
  }
  const activePitches = await referencedListState(franchise, targetRecord.ActivePitches, tableNamesById);
  const pitchRefs = activePitches
    ? activePitches.references.filter((ref) => ref.table === "ActiveRecruitingPitch")
    : [];
  if (!pitchRefs.length) {
    throw new Error(`UserRecruitTarget row ${userRecruitTargetRow} has no ActivePitches references`);
  }
  const selected = pitchRefs[activePitchIndex];
  if (!selected) {
    throw new Error(
      `UserRecruitTarget row ${userRecruitTargetRow} ActivePitches index ${activePitchIndex} is unavailable; `
      + `${pitchRefs.length} pitch row(s) were referenced`,
    );
  }
  return {
    ...item,
    row: selected.row,
    resolvedFrom: {
      table: "UserRecruitTarget",
      row: userRecruitTargetRow,
      field: "ActivePitches",
      listTable: activePitches.table,
      listRow: activePitches.row,
      activePitchIndex,
      activePitchRow: selected.row,
    },
  };
}

async function recruitingBoardRows(franchise, liveTables, snapshot, tableNamesById) {
  const boardTable = liveTables.RecruitingBoard;
  if (!boardTable) return [];
  const rows = [];
  for (let row = 0; row < boardTable.records.length; row += 1) {
    const record = boardTable.records[row];
    if (!record || record.isEmpty) continue;
    const recruitsList = await referencedListState(franchise, record.Recruits, tableNamesById);
    const userTargetRefs = recruitsList
      ? recruitsList.references.filter((ref) => ref.table === "UserRecruitTarget")
      : [];
    const recruitTargetRefs = recruitsList
      ? recruitsList.references.filter((ref) => ref.table === "RecruitTarget")
      : [];
    const userTargetStates = userTargetRefs
      .map((ref) => stateForUserTargetReference(snapshot, ref))
      .filter(Boolean);
    rows.push({
      row,
      recruitingHoursAssigned: record.RecruitingHoursAssigned ?? null,
      recruitingHoursProcessed: record.RecruitingHoursProcessed ?? null,
      recruitingHoursTotal: record.RecruitingHoursTotal ?? null,
      derivedVisibleHoursUsed: Number(record.RecruitingHoursTotal || 0) - Number(record.RecruitingHoursAssigned || 0),
      recruitsList: recruitsList
        ? {
          tableId: recruitsList.tableId,
          table: recruitsList.table,
          row: recruitsList.row,
          referencedRowCount: recruitsList.references.length,
          userRecruitTargetCount: userTargetRefs.length,
          recruitTargetCount: recruitTargetRefs.length,
          userRecruitTargetRows: userTargetRefs.map((ref) => ref.row),
          recruitTargetRows: recruitTargetRefs.map((ref) => ref.row),
          recruitTargetRowsSample: recruitTargetRefs.slice(0, 10).map((ref) => ref.row),
        }
        : null,
      userTargets: userTargetStates.map((state) => ({
        userRecruitTargetRow: state.userRecruitTargetRow,
        recruitRow: state.recruitRow,
        playerRow: state.playerRow,
        name: state.name,
        selectedActionHours: state.selectedActionHours,
        selectedActions: state.selectedActions,
        scholarshipStatus: state.scholarshipStatus,
        currentNilOffer: state.currentNilOffer,
        isFavorite: state.isFavorite,
        activePitches: state.activePitches,
        scheduledVisit: state.scheduledVisit
          ? {
            row: state.scheduledVisit.row,
            activity: state.scheduledVisit.activity,
            weekType: state.scheduledVisit.weekType,
            weekNumber: state.scheduledVisit.weekNumber,
          }
          : null,
        prospectVisitState: state.prospectVisitState,
      })),
    });
  }
  return rows;
}

function buildBoardTargetDiffs(beforeSnapshot, afterSnapshot) {
  const beforeRows = beforeSnapshot.tables.UserRecruitTarget.rows || {};
  const afterRows = afterSnapshot.tables.UserRecruitTarget.rows || {};
  const rowIds = new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)]);
  return [...rowIds]
    .map((rowId) => Number(rowId))
    .sort((a, b) => a - b)
    .map((row) => boardTargetDiff(beforeSnapshot, afterSnapshot, row));
}

function boardRowById(snapshot, row) {
  return (snapshot.boardRows || []).find((board) => board.row === row) || null;
}

function userBoardCandidates(beforeSnapshot, afterSnapshot) {
  const allRows = new Set([
    ...(beforeSnapshot.boardRows || []).map((row) => row.row),
    ...(afterSnapshot.boardRows || []).map((row) => row.row),
  ]);
  const candidates = [];
  for (const row of [...allRows].sort((a, b) => a - b)) {
    const before = boardRowById(beforeSnapshot, row);
    const after = boardRowById(afterSnapshot, row);
    const beforeUserRows = before && before.recruitsList ? before.recruitsList.userRecruitTargetRows : [];
    const afterUserRows = after && after.recruitsList ? after.recruitsList.userRecruitTargetRows : [];
    const userRows = [...new Set([...(beforeUserRows || []), ...(afterUserRows || [])])].sort((a, b) => a - b);
    if (!userRows.length) continue;
    const afterTargets = after ? after.userTargets : [];
    const beforeTargets = before ? before.userTargets : [];
    const selectedActionHours = afterTargets.reduce((total, target) => total + Number(target.selectedActionHours || 0), 0);
    const beforeScholarshipCount = beforeTargets.filter((target) => hasScholarshipOffer(target.scholarshipStatus)).length;
    const scholarshipCount = afterTargets.filter((target) => hasScholarshipOffer(target.scholarshipStatus)).length;
    const beforeScheduledVisitCount = beforeTargets.filter((target) => hasScheduledVisitState(target)).length;
    const afterScheduledVisitCount = afterTargets.filter((target) => hasScheduledVisitState(target)).length;
    candidates.push({
      row,
      evidence: "RecruitingBoard.Recruits references UserRecruitTarget rows",
      confidence: userRows.length === afterTargets.length ? "high-for-this-fixture" : "medium",
      userRecruitTargetRows: userRows,
      derivedBeforeTargetCount: beforeTargets.length,
      derivedAfterTargetCount: afterTargets.length,
      before,
      after,
      derivedAfterSelectedActionHours: selectedActionHours,
      derivedBeforeScholarshipCount: beforeScholarshipCount,
      derivedAfterScholarshipCount: scholarshipCount,
      derivedBeforeScheduledVisitCount: beforeScheduledVisitCount,
      derivedAfterScheduledVisitCount: afterScheduledVisitCount,
      derivedVisibleHours: {
        beforeUsed: before ? before.derivedVisibleHoursUsed : null,
        beforeMax: before ? before.recruitingHoursTotal : null,
        afterUsed: after ? after.derivedVisibleHoursUsed : null,
        afterMax: after ? after.recruitingHoursTotal : null,
      },
    });
  }
  return candidates;
}

function buildVisitEvidence(boardTargets) {
  const targetEvidence = [];
  for (const target of boardTargets) {
    const beforeState = target.before || null;
    const afterState = target.after || null;
    const status = visitStateStatus(beforeState, afterState);
    if (status === "none") continue;
    targetEvidence.push({
      row: target.row,
      name: target.name,
      recruitRow: (afterState && afterState.recruitRow) || (beforeState && beforeState.recruitRow) || null,
      playerRow: (afterState && afterState.playerRow) || (beforeState && beforeState.playerRow) || null,
      status,
      before: compactVisitState(beforeState),
      after: compactVisitState(afterState),
      beforeConsistency: visitConsistency(beforeState),
      afterConsistency: visitConsistency(afterState),
      changedUserRecruitTargetFields: Object.keys(target.userRecruitTargetChanges || {}),
      changedProspectInteractionRows: (target.prospectInteractionChanges || []).map((change) => change.row),
    });
  }
  return {
    scheduledTargetCountBefore: targetEvidence.filter((item) => hasScheduledVisitState(item.before)).length,
    scheduledTargetCountAfter: targetEvidence.filter((item) => hasScheduledVisitState(item.after)).length,
    newScheduledTargetRows: targetEvidence.filter((item) => item.status === "new").map((item) => item.row),
    removedScheduledTargetRows: targetEvidence.filter((item) => item.status === "removed").map((item) => item.row),
    changedScheduledTargetRows: targetEvidence.filter((item) => item.status === "changed").map((item) => item.row),
    unchangedScheduledTargetRows: targetEvidence.filter((item) => item.status === "unchanged").map((item) => item.row),
    targets: targetEvidence,
  };
}

async function recruitingSnapshot(filePath, label) {
  const franchise = await loadFranchise(filePath);
  const liveTables = await readRecruitingDiffTables(franchise);
  const namesById = tableNameById(liveTables, franchise);
  const tables = {};
  for (const name of RECRUITING_DIFF_TABLES) {
    tables[name] = tableSnapshot(liveTables[name], namesById, name);
  }
  const snapshot = {
    label,
    file: path.basename(filePath),
    tableNamesById: namesById,
    tables,
  };
  snapshot.boardRows = await recruitingBoardRows(franchise, liveTables, snapshot, namesById);
  return snapshot;
}

async function recruitingDiff(beforePath, afterPath, beforeLabel, afterLabel) {
  const before = await recruitingSnapshot(beforePath, beforeLabel || path.basename(beforePath));
  const after = await recruitingSnapshot(afterPath, afterLabel || path.basename(afterPath));
  const tableDiffs = {};
  for (const tableName of RECRUITING_DIFF_TABLES) {
    tableDiffs[tableName] = diffTableSnapshots(
      tableName,
      before.tables[tableName],
      after.tables[tableName],
    );
  }
  const boardTargets = buildBoardTargetDiffs(before, after);
  const boardCandidates = userBoardCandidates(before, after);
  const visitEvidence = buildVisitEvidence(boardTargets);
  return {
    kind: "cfb27.recruitingDiff.v1",
    readOnly: true,
    before: {
      label: before.label,
      file: before.file,
    },
    after: {
      label: after.label,
      file: after.file,
    },
    tableDiffs,
    boardCandidates,
    visitEvidence,
    boardTargets,
  };
}

function applyPatch(pair, changes) {
  const { recruitRecord, playerRecord } = pair;
  const allowed = new Set([
    "first_name",
    "last_name",
    "position",
    "jersey_number",
    "height_inches",
    "weight_lbs",
    "national_rank",
    "position_rank",
    "state_rank",
    "star_rating",
    "generic_head_asset_name",
    "dev_trait",
    "dealbreaker",
    "mental_ability_1",
    "mental_ability_2",
    "mental_ability_3",
    "mental_rank_1",
    "mental_rank_2",
    "mental_rank_3",
    "physical_rank_1",
    "physical_rank_2",
    "physical_rank_3",
    "physical_rank_4",
    "physical_rank_5",
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
  if (Object.prototype.hasOwnProperty.call(changes, "jersey_number")) {
    playerRecord.JerseyNum = cleanInt(changes.jersey_number, "Jersey number", 0, 99);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "weight_lbs")) {
    const pounds = cleanInt(changes.weight_lbs, "Weight", 160, 415);
    playerRecord.Weight = rawWeightFromPounds(pounds);
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
  if (Object.prototype.hasOwnProperty.call(changes, "star_rating")) {
    if (!PROSPECT_STAR_RATINGS.includes(changes.star_rating)) {
      throw new Error(`Star rating must be one of: ${PROSPECT_STAR_RATINGS.join(", ")}`);
    }
    playerRecord.ProspectStarRating = encodeProspectStarRating(
      playerRecord.ProspectStarRating,
      changes.star_rating,
    );
  }
  if (Object.prototype.hasOwnProperty.call(changes, "generic_head_asset_name")) {
    playerRecord.GenericHeadAssetName = cleanString(
      changes.generic_head_asset_name,
      "Head asset",
      33,
    );
  }
  if (Object.prototype.hasOwnProperty.call(changes, "dev_trait")) {
    if (!DEVELOPMENT_TRAITS.includes(changes.dev_trait)) {
      throw new Error(`Dev trait must be one of: ${DEVELOPMENT_TRAITS.join(", ")}`);
    }
    playerRecord.TraitDevelopment = changes.dev_trait;
  }
  if (Object.prototype.hasOwnProperty.call(changes, "dealbreaker")) {
    playerRecord.RecruitingDealbreaker = encodeDealbreaker(
      playerRecord.RecruitingDealbreaker,
      changes.dealbreaker,
    );
  }
  for (const index of [1, 2, 3]) {
    const abilityKey = `mental_ability_${index}`;
    const rankKey = `mental_rank_${index}`;
    if (Object.prototype.hasOwnProperty.call(changes, abilityKey)) {
      if (!MENTAL_ABILITIES.includes(changes[abilityKey])) {
        throw new Error(`${abilityKey} must be a known mental ability`);
      }
      playerRecord[`MentalAbility${index}`] = changes[abilityKey];
    }
    if (Object.prototype.hasOwnProperty.call(changes, rankKey)) {
      if (!ABILITY_RANKS.includes(changes[rankKey])) {
        throw new Error(`${rankKey} must be one of: ${ABILITY_RANKS.join(", ")}`);
      }
      playerRecord[`MentalAbilityRank${index}`] = changes[rankKey];
    }
  }
  for (const index of [1, 2, 3, 4, 5]) {
    const rankKey = `physical_rank_${index}`;
    if (Object.prototype.hasOwnProperty.call(changes, rankKey)) {
      if (!ABILITY_RANKS.includes(changes[rankKey])) {
        throw new Error(`${rankKey} must be one of: ${ABILITY_RANKS.join(", ")}`);
      }
      playerRecord[`PhysicalAbility${index}`] = changes[rankKey];
    }
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

async function patchRecruitBatch(filePath, patchPath, outputPath) {
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  if (!Array.isArray(patch.patches) || !patch.patches.length) {
    throw new Error("Batch patches are missing");
  }

  const franchise = await loadFranchise(filePath);
  const { recruitTable, playerTable } = await readRecruitTables(franchise);
  const seen = new Set();
  for (const item of patch.patches) {
    const recruitIndex = Number(item.id);
    if (!Number.isInteger(recruitIndex) || recruitIndex < 0) {
      throw new Error("Recruit id is invalid");
    }
    if (seen.has(recruitIndex)) {
      throw new Error(`Recruit ${recruitIndex} was supplied more than once`);
    }
    seen.add(recruitIndex);
    if (!item.changes || typeof item.changes !== "object") {
      throw new Error(`Patch changes are missing for recruit ${recruitIndex}`);
    }
    const pair = recruitPlayerPair(recruitTable.records[recruitIndex], recruitIndex, playerTable);
    if (!pair) {
      throw new Error(`Recruit row ${recruitIndex} was not found or does not reference a valid player`);
    }
    applyPatch(pair, item.changes);
  }

  const unpacked = franchise.strategy.file.generateUnpackedContents(
    franchise.tables,
    franchise.unpackedFileContents,
  );
  fs.writeFileSync(outputPath, unpacked);

  const verify = await loadFranchise(outputPath);
  const { recruitTable: verifyRecruitTable, playerTable: verifyPlayerTable } = await readRecruitTables(verify);
  const updated = [];
  for (const recruitIndex of seen) {
    const updatedPair = recruitPlayerPair(verifyRecruitTable.records[recruitIndex], recruitIndex, verifyPlayerTable);
    updated.push(rowFromPair(updatedPair));
  }
  return { players: updated };
}

async function recruitingProbeAction(filePath, patchPath, outputPath) {
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  const boardRow = Number(patch.boardRow);
  const adjustBoardHours = patch.adjustBoardHours !== false;
  if (adjustBoardHours && (!Number.isInteger(boardRow) || boardRow < 0)) {
    throw new Error("boardRow is required when adjustBoardHours is enabled");
  }
  const actionPatches = Array.isArray(patch.patches)
    ? patch.patches
    : (patch.actionField ? [{
      userRecruitTargetRow: patch.userRecruitTargetRow,
      actionField: patch.actionField,
      enabled: patch.enabled !== false,
    }] : []);
  const fieldPatches = Array.isArray(patch.fieldPatches) ? patch.fieldPatches : [];
  if (!actionPatches.length && !fieldPatches.length) {
    throw new Error("At least one recruiting action patch is required");
  }

  const franchise = await loadFranchise(filePath, {
    autoUnempty: fieldPatches.some((item) => item.allowEmpty),
  });
  const liveTables = await readRecruitingDiffTables(franchise);
  const tableNamesById = tableNameById(liveTables, franchise);
  const targetTable = liveTables.UserRecruitTarget;
  const boardTable = liveTables.RecruitingBoard;
  if (!targetTable) throw new Error("UserRecruitTarget table is unavailable");
  if (adjustBoardHours && !boardTable) throw new Error("RecruitingBoard table is unavailable");
  const changes = [];
  let selectedHourDelta = 0;
  const changedTargetRows = new Set();
  const seenActionKeys = new Set();
  for (const item of actionPatches) {
    const userRecruitTargetRow = Number(item.userRecruitTargetRow);
    const actionField = String(item.actionField || "");
    const enabled = item.enabled !== false;
    if (!Number.isInteger(userRecruitTargetRow) || userRecruitTargetRow < 0) {
      throw new Error("userRecruitTargetRow is invalid");
    }
    if (!Object.prototype.hasOwnProperty.call(WEEKLY_ACTION_HOURS, actionField)) {
      throw new Error(`Unsupported recruiting action field: ${actionField}`);
    }
    const actionKey = `${userRecruitTargetRow}:${actionField}`;
    if (seenActionKeys.has(actionKey)) {
      throw new Error(`Duplicate recruiting action patch: ${actionKey}`);
    }
    seenActionKeys.add(actionKey);
    const targetRecord = targetTable.records[userRecruitTargetRow];
    if (!targetRecord || targetRecord.isEmpty) {
      throw new Error(`UserRecruitTarget row ${userRecruitTargetRow} is unavailable`);
    }
    const beforeActionValue = targetRecord[actionField] === true;
    if (beforeActionValue === enabled) {
      throw new Error(`UserRecruitTarget row ${userRecruitTargetRow} already has ${actionField}=${enabled}`);
    }

    const actionHours = WEEKLY_ACTION_HOURS[actionField];
    selectedHourDelta += enabled ? actionHours : -actionHours;
    changes.push({
      table: "UserRecruitTarget",
      row: userRecruitTargetRow,
      field: actionField,
      before: beforeActionValue,
      after: enabled,
      hours: actionHours,
      selectedHourDelta: enabled ? actionHours : -actionHours,
    });
    targetRecord[actionField] = enabled;
    changedTargetRows.add(userRecruitTargetRow);
  }

  for (const fieldPatch of fieldPatches) {
    const resolvedPatch = await resolveActivePitchFieldPatch(franchise, liveTables, fieldPatch, tableNamesById);
    const change = patchFieldValue(franchise, liveTables, resolvedPatch);
    changes.push(change);
    if (change.table === "UserRecruitTarget") {
      changedTargetRows.add(change.row);
    }
  }

  if (adjustBoardHours) {
    const boardRecord = boardTable.records[boardRow];
    if (!boardRecord || boardRecord.isEmpty) {
      throw new Error(`RecruitingBoard row ${boardRow} is unavailable`);
    }
    const beforeAssigned = Number(boardRecord.RecruitingHoursAssigned || 0);
    const afterAssigned = beforeAssigned - selectedHourDelta;
    if (!Number.isFinite(afterAssigned) || afterAssigned < 0) {
      throw new Error(`RecruitingBoard row ${boardRow} does not have enough assigned hours for this probe`);
    }
    boardRecord.RecruitingHoursAssigned = afterAssigned;
    changes.push({
      table: "RecruitingBoard",
      row: boardRow,
      field: "RecruitingHoursAssigned",
      before: beforeAssigned,
      after: afterAssigned,
    });
  }

  const unpacked = franchise.strategy.file.generateUnpackedContents(
    franchise.tables,
    franchise.unpackedFileContents,
  );
  fs.writeFileSync(outputPath, unpacked);

  const verify = await recruitingSnapshot(outputPath, "probe-after");
  const verifiedTargets = [...changedTargetRows].sort((a, b) => a - b).map((row) => {
    const state = userRecruitTargetState(verify, row);
    return state
      ? {
        userRecruitTargetRow: row,
        name: state.name,
        selectedActions: state.selectedActions,
        selectedActionHours: state.selectedActionHours,
      }
      : null;
  }).filter(Boolean);
  const verifiedBoard = boardRowById(verify, boardRow);
  const firstUserChange = changes.find((change) => change.table === "UserRecruitTarget");
  return {
    kind: "cfb27.recruitingProbeAction.v1",
    readOnly: false,
    copyOnlyPayload: true,
    userRecruitTargetRow: firstUserChange ? firstUserChange.row : null,
    boardRow,
    actionField: firstUserChange ? firstUserChange.field : null,
    enabled: firstUserChange ? firstUserChange.after : null,
    actionHours: firstUserChange ? firstUserChange.hours : null,
    selectedHourDelta,
    changes,
    verifiedTargets,
    verifiedTarget: verifiedTargets.length ? verifiedTargets[0] : null,
    verifiedBoard: verifiedBoard
      ? {
        row: verifiedBoard.row,
        recruitingHoursAssigned: verifiedBoard.recruitingHoursAssigned,
        recruitingHoursProcessed: verifiedBoard.recruitingHoursProcessed,
        recruitingHoursTotal: verifiedBoard.recruitingHoursTotal,
        derivedVisibleHoursUsed: verifiedBoard.derivedVisibleHoursUsed,
      }
      : null,
  };
}

async function main() {
  const [command, filePath, arg1, arg2, arg3] = process.argv.slice(2);
  if (!command || !filePath) {
    fail("Usage: node franchise_helper.js <list|joined|player-search|player-record-patch|league-edit-permission-patch|franchise-owner-patch|patch|patch-batch|research|recruiting-board|recruiting-diff|recruiting-probe-action> <file> ...");
  }
  if (command === "list") {
    const result = await listRecruits(filePath, Number(arg1 || 1000), Number(arg2 || 0));
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "joined") {
    const result = await joinedRecruitProfiles(filePath, Number(arg1 || 1000), Number(arg2 || 0));
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "player-search") {
    const result = await searchPlayers(filePath, arg1 || "", Number(arg2 || 100));
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "player-record-patch") {
    if (arg1 === undefined || !arg2 || arg3 === undefined) fail("Player record patch requires <row> <rating-field> <value>");
    const result = await buildPlayerRecordPatch(filePath, arg1, arg2, arg3);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "league-edit-permission-patch") {
    const result = await buildLeagueEditPermissionPatch(filePath, arg1 || "ANY");
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "franchise-owner-patch") {
    const result = await buildFranchiseOwnerPatch(filePath);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "patch") {
    if (!arg1 || !arg2) fail("Patch requires <patch.json> <output-file>");
    const result = await patchRecruit(filePath, arg1, arg2);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "patch-batch") {
    if (!arg1 || !arg2) fail("Patch batch requires <patch.json> <output-file>");
    const result = await patchRecruitBatch(filePath, arg1, arg2);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "research") {
    const result = await researchRecruitFields(filePath, Number(arg1 || 0));
    if (arg2) {
      fs.mkdirSync(path.dirname(path.resolve(arg2)), { recursive: true });
      fs.writeFileSync(arg2, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({
        file: result.file,
        artifact: path.resolve(arg2),
        gates: result.gates,
        fieldAvailability: result.fieldAvailability,
        missingFields: result.missingFields,
        observedFieldCount: Object.keys(result.observedValues).length,
      }));
      return;
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "recruiting-board") {
    const result = await recruitingWorkbenchBoard(filePath);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "recruiting-diff") {
    if (!arg1) fail("Recruiting diff requires <before-frk-payload> <after-frk-payload> [before-label] [after-label]");
    const result = await recruitingDiff(filePath, arg1, arg2, arg3);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "recruiting-probe-action") {
    if (!arg1 || !arg2) fail("Recruiting probe action requires <patch.json> <output-file>");
    const result = await recruitingProbeAction(filePath, arg1, arg2);
    console.log(JSON.stringify(result));
    return;
  }
  fail(`Unknown command: ${command}`);
}

main().catch((error) => fail(error.stack || error.message));

# CFB 26 Recruit Generation and Player Development Manifesto

## Purpose

The objective is to rebuild recruit generation and player development in College Football 26 around realistic talent distributions, believable player identities, tighter career growth, and meaningful gameplay differentiation.

This system must work within the limitations of the existing game database. It is not intended to replace the game engine. It will manipulate the fields already exposed by the recruit and player tables, then use validation and periodic normalization to keep game-generated outcomes within realistic boundaries.

The core principles are:

* National recruiting rank should meaningfully predict prospect quality.
* Star ratings should describe rank bands, not create artificial talent cliffs.
* Elite freshmen should be allowed to enter college already elite.
* Most players should improve modestly rather than transform completely.
* Physical traits should remain relatively stable.
* Technical and mental development should account for most career improvement.
* Archetypes should represent real football identities.
* Ability badges should communicate exceptional gameplay traits.
* Elite development should be extremely rare.
* Body type must reflect the actual in-game visual presets rather than their misleading labels.
* Overall rating should emerge from the player profile rather than act as the primary generation target.

---

# 1. Database Structure

A recruit is not self-contained.

The `Recruit.Player` field links the recruit row to the authoritative row in the main `Player` table.

The generator must treat both rows as one joined object.

## Recruit row responsibilities

The `Recruit` table should control:

* Recruit class or source
* National rank
* Position rank
* State rank
* Recruiting stage
* Gem or bust status
* Production grade
* Offer count
* Top-school data

Important fields include:

* `Player`
* `Class`
* `NationalRank`
* `PositionRank`
* `StateRank`
* `QualityModifier`
* `ProductionGrade`
* `TotalScholarshipOffers`
* `RecruitStage`
* `TopSchoolsList`

## Linked Player row responsibilities

The linked `Player` row should control:

* Identity
* Hometown and pipeline
* Position
* Archetype
* Height and weight
* Body type
* Individual ratings
* Overall rating
* Star rating
* Development trait
* Skill-group caps
* Physical abilities
* Mental abilities
* NIL and recruiting motivations
* Appearance tokens

Important fields include:

* `Position`
* `PlayerType`
* `Height`
* `Weight`
* `CharacterBodyType`
* `OverallRating`
* Individual ratings
* `ProspectStarRating`
* `TraitDevelopment`
* `SkillGroupCap1-6`
* `PhysicalAbility1-5`
* `MentalAbility1-3`
* `GenericHeadAssetName`
* `PLYR_PORTRAIT`

The tool should join the recruit and linked player rows before generation begins and write back to both only after the complete profile passes validation.

---

# 2. Generation Philosophy

The generator must create football players, not collections of unrelated random ratings.

Each recruit should be created from a coherent underlying profile containing:

* National rank
* Position
* Archetype
* Readiness
* Physical talent
* Technical polish
* Mental readiness
* Development ceiling
* Development probability
* Evaluation confidence
* Body composition
* Appearance token

The player should first be given a football identity. His ratings, development trait, caps, abilities, size, body type, star rating, and gem or bust status should then be derived from that identity.

The system must not independently randomize each major field.

---

# 3. Class-Level Generation

Recruit scarcity must be controlled at the class level.

Before generating individual players, create a class budget for:

* Total recruit count
* Position distribution
* Archetype distribution
* Five-star count
* Four-star count
* Generational-player count
* Elite-development count
* Ability-tier count
* Gem count
* Bust count
* Geographic distribution
* Class-strength modifier

The generator should not roll every recruit independently and hope the final distribution is realistic.

A class-level plan might specify:

```text
Total recruits: 4,100
Five-stars: 32
Four-stars: approximately 368
Generational freshmen rated 88 or higher: 0-2
Elite development players: 5-10
Incoming Platinum physical abilities: 0-3
Class strength modifier: -1.0 to +1.0 OVR
```

These values should be configurable.

---

# 4. National Rank and Star Ratings

National rank should be the strongest predictor of expected recruit quality.

It should not determine an exact overall rating.

Higher-ranked recruits should have better expected profiles, but rating ranges should overlap.

A polished player ranked 100th may enter college with a higher overall rating than a raw player ranked 20th. The player ranked 20th should normally possess greater long-term value, better physical projection, stronger caps, better development odds, or more exceptional abilities.

## Recommended freshman overall bands

| National rank | Expected OVR | Typical range | Rare maximum |
| ------------: | -----------: | ------------: | -----------: |
|           1–5 |        85–87 |         83–88 |           90 |
|          6–10 |        83–85 |         81–87 |           88 |
|         11–32 |        81–83 |         78–85 |           87 |
|         33–60 |        79–81 |         76–83 |           85 |
|        61–150 |        76–78 |         72–81 |           84 |
|       151–250 |        73–75 |         69–78 |           82 |
|       251–400 |        70–72 |         66–76 |           80 |
|       401–600 |        67–70 |         64–73 |           78 |
|     601–1,000 |        64–67 |         60–70 |           75 |
|   1,001–1,500 |        60–63 |         56–67 |           72 |
|        1,501+ |        56–60 |         50–64 |           70 |

These are validation targets rather than direct assignments.

## Star-rating rules

Star rating should be rank-derived.

Recommended initial cutoffs:

```text
National ranks 1-32:
    FIVE_STAR

National ranks 33-400:
    FOUR_STAR

National ranks 401-1500:
    THREE_STAR

National ranks 1501-3000:
    TWO_STAR

National ranks 3001 and below:
    ONE_STAR
```

The exact lower cutoffs may later be adjusted to match the desired class composition.

There should be no artificial ability or rating cliff between ranks 32 and 33.

`ProspectStarRating` should describe the rank category. It should not independently modify talent.

---

# 5. Prospect Profile Types

Each recruit should be assigned a profile type before individual ratings are generated.

Recommended profile types include:

## Complete Prodigy

* Extremely high readiness
* High physical quality
* High technical quality
* High mental readiness
* Limited remaining growth compared with raw prospects
* Common only near the top of the class

## Rare Physical Freak

* Exceptional physical ratings
* Strong physical ability package
* Lower technical and mental ratings
* Wide technical development ceiling
* Higher career variance

## Elite Technician

* Advanced positional skills
* Strong awareness or processing
* Good but not generational physical profile
* High freshman overall
* Relatively narrow remaining growth

## Balanced Blue-Chip

* Strong across most categories
* No singular generational trait
* High floor
* Moderate-to-high ceiling

## Raw Athlete

* One or more elite physical traits
* Major technical deficiencies
* Lower immediate overall than rank peers
* High developmental volatility

## Polished Low-Ceiling Player

* Ready to contribute early
* Strong technical ratings
* Average or modest physical ceiling
* Tight caps

## Frame Projection

* Underdeveloped mass or strength
* Height and frame suitable for future growth
* Physical ratings constrained by current build
* Significant strength and weight-growth potential

## Balanced Developmental Player

* No extreme strengths or weaknesses
* Moderate readiness
* Moderate ceiling
* Typical of the middle recruiting tiers

## Evaluation Miss

* True profile differs meaningfully from public rank
* May become a gem or bust
* Should remain rare

Profile-type frequencies must vary by rank band.

Top-ranked players should more often be complete, exceptional, or visibly dominant in at least one area.

Lower-ranked players should increasingly be defined by tradeoffs.

---

# 6. Overall Rating

Overall rating should not be the main generation variable.

The generator should create:

1. Position
2. Archetype
3. Size
4. Physical ratings
5. Technical ratings
6. Mental ratings
7. Development profile
8. Abilities

The game’s overall rating should then be inspected.

If the resulting overall falls outside the intended rank band, the tool should adjust archetype-relevant ratings while preserving the player’s original identity.

The tool must not simply apply a flat bonus or penalty to all ratings.

A player should remain recognizable after normalization.

---

# 7. Archetypes

`PlayerType` should represent the player’s intended football identity.

Archetypes must be chosen before ratings are generated.

The archetype should control:

* Rating template
* Core ratings
* Secondary ratings
* Likely weaknesses
* Height and weight distribution
* Ability pool
* Development priorities
* Skill-group cap logic
* Alternate-position compatibility

Archetypes must not be assigned solely by whichever category gives the highest overall rating.

A receiver with high speed should not automatically become a speed archetype if his complete profile better matches a route technician or contested-catch player.

Each archetype should have a qualification score based on relevant ratings and physical traits.

Archetype defines what the player is.

National rank defines how good that version of the archetype is.

---

# 8. Ratings Categories

Individual ratings should be divided into development categories.

## Mostly fixed physical traits

Examples:

* Speed
* Natural arm strength
* Height
* Frame
* Kick power
* Natural explosiveness

Recommended career movement:

```text
Typical:
    -1 to +2

Rare:
    +3

Extreme:
    +4
```

A slow freshman should almost never become a truly fast senior.

## Moderately trainable athletic traits

Examples:

* Acceleration
* Agility
* Change of direction
* Jumping
* Stamina
* Toughness

Recommended career movement:

```text
Typical:
    0 to +3

Strong development:
    +4 to +5

Extreme:
    +6
```

Negative movement should also be possible, especially after excessive weight gain.

## Highly trainable physical traits

Examples:

* Strength
* Functional mass
* Contact resistance
* Run-block power
* Pass-block power
* Block shedding
* Press strength
* Hit power

Recommended career movement:

```text
Typical:
    +2 to +7

Strong development:
    +8 to +11

Extreme:
    +12 to +15
```

## Technical and mental traits

Examples:

* Awareness
* Play recognition
* Route running
* Throw accuracy
* Pass-rush moves
* Coverage technique
* Blocking technique
* Ball-carrier vision
* Catching
* Tackling
* Pursuit
* Assignment reliability

These should account for most player development.

Recommended career movement:

```text
Typical:
    +3 to +8

Strong development:
    +9 to +12

Extreme:
    +13 to +16
```

Large gains should be concentrated in specific weak areas rather than distributed evenly across every rating.

---

# 9. Freshman Ratings and Career Growth

Elite freshmen must be allowed to enter the game already elite.

A truly generational freshman may begin between 88 and 90 overall.

Such players should appear roughly every three to five classes as a broad target, with 90-overall freshmen rarer than 88-overall freshmen.

An elite freshman should not automatically have enormous remaining growth.

A player who enters at 88 may finish at 92 to 96 rather than inevitably reaching 99.

## Career overall growth targets

| Career OVR gain | Frequency                 |
| --------------: | ------------------------- |
|             0–3 | Common                    |
|             4–6 | Very common               |
|             7–9 | Strong development        |
|           10–12 | Rare                      |
|           13–15 | Extremely rare            |
|             16+ | Near-generational outlier |

The typical successful four-year player should gain approximately four to seven overall points.

A gain above ten points should usually require:

* A raw initial profile
* Significant technical deficiencies
* High skill-group ceilings
* Strong development trait
* Successful progression outcomes

Players should not routinely improve by 12 to 20 overall points simply because they remain on a roster.

---

# 10. Development Traits

`TraitDevelopment` should represent the probability and speed with which a player realizes his available growth.

It should not act as an automatic promise of superstardom.

Recommended class-wide distribution:

| Trait          | Target share |
| -------------- | -----------: |
| Normal         |       77–80% |
| College Impact |       16–19% |
| College Star   |       3.5–5% |
| College Elite  |   0.15–0.30% |

For a class of approximately 4,100 recruits, this implies roughly:

```text
Normal:
    approximately 3,200

Impact:
    approximately 700

Star:
    approximately 150-200

Elite:
    approximately 6-12
```

Elite development must remain extremely rare.

Elite development should be required for a player to exceed approximately 96 overall.

Elite development should permit 99 overall but never guarantee it.

A 99-overall player should require:

* Elite development
* High skill-group ceilings
* Exceptional starting traits
* Successful progression
* A complete archetype-relevant rating profile
* No major developmental derailment

A highly polished freshman may have Star development rather than Elite because he is already close to his ceiling.

A raw physical freak may have Elite development while beginning at a lower overall rating.

---

# 11. Skill-Group Caps

`SkillGroupCap1-6` should eventually control the amount and location of available development.

These fields must not be mass-edited until their exact behavior and slot mapping are confirmed.

Required investigation:

* Determine which cap slot maps to which skill group for every archetype.
* Determine whether higher values represent higher ceilings or stronger restrictions.
* Determine the meaning of zero.
* Determine whether unused cap fields matter.
* Determine how caps interact with development traits and class year.

Once decoded, caps should reflect the recruit profile.

## Polished prospect

* High starting ratings
* Tight technical caps
* Limited physical growth
* Smaller overall growth budget

## Raw athlete

* High physical ratings
* Tight physical caps
* Wide technical and mental caps
* Greater career variance

## Balanced prospect

* Moderate starting ratings
* Moderate caps
* Moderate growth budget

## Generational prospect

* High starting ratings
* High caps
* Star or Elite development
* Extremely rare

Skill-group caps should be the primary tool for preventing unrealistic career inflation.

---

# 12. Gem and Bust Logic

`QualityModifier` should represent evaluation error rather than act as a flat rating modifier.

## NORMAL

The true profile reasonably matches the player’s national rank.

## GEM

The player is meaningfully better than his ranking suggests.

A gem may possess:

* Better initial readiness
* Better physical traits
* Better technical ability
* Better development trait
* Better caps
* Better ability package
* Better archetype fit

A gem should not automatically receive every possible advantage.

## BUST

The player’s profile is more limited than his rank suggests.

A bust may have:

* Lower readiness
* Lower ceilings
* Poor mental ratings
* Incomplete technical development
* Positional limitations
* Weak archetype fit
* One elite trait surrounded by major deficiencies

A highly ranked bust should still retain the trait that made him highly ranked.

He should not become an entirely ordinary player.

## HIDDEN

Do not intentionally assign this value until its behavior is understood.

It may represent unrevealed scouting state rather than talent quality.

## Suggested gem and bust rates

| Rank band | Gem rate | Bust rate |
| --------: | -------: | --------: |
|      1–32 |     3–5% |    12–18% |
|    33–100 |     6–9% |    12–18% |
|   101–400 |    8–12% |    10–15% |
|   401–800 |    8–12% |     7–12% |
| 801–1,500 |     5–8% |     5–10% |
|    1,501+ |     2–5% |      4–8% |

Lower-ranked players should occasionally become elite, but true hidden superstars must remain rare.

Rankings should remain strongly predictive.

---

# 13. Ability Badges

Ability badges are a major gameplay component and should be treated as scarce differentiators.

Ratings establish capability.

Abilities establish distinction.

A player should receive an ability because he possesses a defining trait or advanced skill that meaningfully affects gameplay.

Abilities should not be awarded simply because the player has a high overall rating.

## Ability-tier meaning

| Tier     | Intended meaning                 |
| -------- | -------------------------------- |
| Bronze   | Clearly above-average trait      |
| Silver   | High-end conference-level weapon |
| Gold     | Nationally elite defining trait  |
| Platinum | Rare, game-altering trait        |

A balanced 94-overall player may have no Platinum ability.

A raw 79-overall athlete may possess one Gold ability because he has one exceptional trait surrounded by weaknesses.

## Suggested incoming-class ability distribution

| Ability tier |    Initial target |
| ------------ | ----------------: |
| Platinum     |         0–3 total |
| Gold         |       25–60 total |
| Silver       |     150–300 total |
| Bronze       |     400–750 total |
| No ability   | Majority of class |

These values should be configurable and gameplay-tested.

Ability assignment should follow this sequence:

```text
Position
→ Archetype
→ Eligible ability pool
→ Player ratings
→ Rating thresholds
→ Profile distinction
→ Ability tier
```

Abilities should be assigned after ratings exist.

The tool must verify how physical ability identity and tier are encoded before editing `PhysicalAbility1-5`.

Mental abilities should also remain untouched until their exact field behavior is confirmed.

---

# 14. Size, Weight, and Frame

Height, weight, archetype, body type, and physical ratings should be generated as one connected system.

The database stores weight as:

```text
Stored weight = displayed pounds - 160
```

All code should use centralized conversion helpers.

```python
def encode_weight(display_weight: int) -> int:
    return display_weight - 160


def decode_weight(stored_weight: int) -> int:
    return stored_weight + 160
```

The conversion must not be duplicated manually throughout the codebase.

Each player should have a hidden frame or body-composition profile.

Recommended values:

```text
LEAN
SOFT
ATHLETIC
MUSCULAR
HIGH_FAT
```

This profile should help determine `CharacterBodyType`.

---

# 15. Character Body Types

`CharacterBodyType` must be treated as a constrained visual-mesh selection system, not as a universal biological classification. The database labels are misleading. The generator must use the way each preset actually appears in game.

## In-game visual meaning

### Freshman

Actual appearance:

* Very lean
* Narrow
* Under-massed
* Rail-thin

Appropriate for:

* Lean wide receivers
* Lean defensive backs
* Some underbuilt quarterbacks
* Some kickers and punters

`Freshman` does not mean that the player is literally a freshman. It represents a visibly underdeveloped frame.

### Thin

Actual appearance:

* Soft-bodied
* Dad-bod build
* Limited muscular definition
* Not genuinely thin

Appropriate for:

* Traditional pocket quarterbacks
* Some receiving tight ends
* Kickers and punters
* Occasional soft-bodied specialists

`Thin` must not be used as the default for lightweight or lean players.

### Standard

Actual appearance:

* Balanced athletic build
* Developed football body
* Leaner than the line meshes
* Appropriate for most trained skill and second-level defenders

Appropriate for:

* Most wide receivers and defensive backs
* Athletic quarterbacks
* Running backs without extreme muscularity
* Linebackers and edge defenders with leaner builds
* Balanced tight ends

### Muscular

Actual appearance:

* Extremely muscular
* Visibly powerful
* Thick, developed, low-fat build
* Suitable for both compact power players and massive athletic linemen

Appropriate for:

* Power running backs
* Tight ends
* Linebackers
* Edge defenders
* Freak defensive linemen
* Freak offensive linemen
* Thick safeties
* Rare power-running quarterbacks

### Heavy

Actual appearance:

* High-fat
* Obese-looking
* Extremely soft and massive
* Not simply large or stocky

Appropriate for:

* High-fat offensive linemen
* Massive nose tackles
* Heavy interior defensive linemen
* Rare oversized kickers and punters

`Heavy` must not be assigned merely because a player weighs a lot.

## Position-Based Legal Body-Type Pools

The body-type formula must never select from all five presets. It must first determine the player's position group and restrict the available body types to the legal visual pool for that group.

| Position group | Allowed body types |
| -------------- | ------------------ |
| Offensive line | `Muscular`, `Heavy` |
| Interior defensive line | `Muscular`, `Heavy` |
| EDGE | `Standard`, `Muscular` |
| Linebacker | `Standard`, `Muscular` |
| Wide receiver | `Freshman`, `Standard`, ultra-rare `Muscular` |
| Cornerback | `Freshman`, `Standard`, ultra-rare `Muscular` |
| Safety | `Freshman`, `Standard`, rare `Muscular` |
| Running back | `Standard`, `Muscular` |
| Fullback | `Standard`, `Muscular` |
| Quarterback | `Freshman`, `Thin`, `Standard`, `Muscular` |
| Tight end | `Thin`, `Standard`, `Muscular` |
| Kicker | All five |
| Punter | All five |

These overrides are authoritative.

A mathematically plausible result must still be rejected when the corresponding in-game mesh looks wrong for the position.

Examples:

* An offensive lineman must never be `Standard`.
* A running back must never be `Heavy`.
* An edge defender or linebacker must never be `Freshman`, even when underweight.
* A quarterback must never be `Heavy`.
* A wide receiver or defensive back should almost never be `Muscular`.

## Body-Type Classification Inputs

The classifier should use three normalized metrics.

### Mass Index

The Mass Index measures how much weight the player carries relative to height and position.

```text
MassIndex = actual player weight compared with expected weight for the same height and position group
```

This should be based on position-specific roster data whenever possible.

### Movement Index

The Movement Index measures how athletically the player carries his frame.

```text
MovementIndex = 0.35 x position-relative Speed percentile
              + 0.40 x position-relative Acceleration percentile
              + 0.25 x position-relative Agility percentile
```

Acceleration receives the greatest weight because it is especially useful for distinguishing functional mass from excess mass. All components should be normalized within position groups.

### Strength Index

The Strength Index is the player's strength percentile within his position group.

```text
StrengthIndex = position-relative Strength percentile
```

Strength is used as the final separator between soft mass, balanced athletic mass, functional muscular mass, and excess mass.

## Classification Order

The body-type classifier must operate in this order:

```text
1. Determine position group.
2. Load legal body-type pool.
3. Calculate Mass Index.
4. Calculate Movement Index.
5. Calculate Strength Index.
6. Score only the legal body types.
7. Apply rarity limits and hard overrides.
8. Choose the highest-confidence valid mesh.
```

The tool should never calculate a universal body type and then blindly write it to the database.

## Position-Specific Rules

Offensive line and interior defensive line are limited to `Muscular` and `Heavy`. Use `Muscular` when the player carries size with functional strength and movement; use `Heavy` when mass is not carried athletically. Strength alone must not prevent `Heavy`.

EDGE and linebackers are limited to `Standard` and `Muscular`. They must never use `Freshman`, `Thin`, or `Heavy`. A 6'5", 220-pound edge defender should be `Standard`, with underdevelopment reflected by listed weight, strength, and ratings.

Wide receivers and cornerbacks may use `Freshman`, `Standard`, and ultra-rare `Muscular`. `Freshman` should be for visibly under-massed players, normally under 200 pounds. `Muscular` should be limited to rare compact, powerful builds, approximately 0.5% to 1.5% of WR and CB recruits.

Safeties may use `Freshman`, `Standard`, and rare `Muscular`. `Muscular` should require high strength, preserved movement, and above-average mass.

Running backs and fullbacks are limited to `Standard` and `Muscular`. They must never use `Heavy`, even for high-mass power backs, because the `Heavy` mesh is visually unacceptable for ball carriers.

Quarterbacks may use `Freshman`, `Thin`, `Standard`, and `Muscular`; they must never use `Heavy`. Tall underbuilt quarterbacks may slightly exceed 200 pounds and still use `Freshman`.

| Height | Maximum typical Freshman-body weight |
| -----: | -----------------------------------: |
| 5'8"-5'11" | 185 |
| 6'0"-6'1" | 192 |
| 6'2"-6'3" | 198 |
| 6'4" | 203 |
| 6'5"-6'6" | 208 |

Tight ends may use `Thin`, `Standard`, and `Muscular`; they should not use `Freshman` or `Heavy`.

Kickers and punters may use all five body types.

## Internal Body Composition Versus Final Game Mesh

The generator should distinguish between the player's calculated body composition and the best available in-game mesh. These are not always identical.

Example:

```text
Calculated body composition: HIGH_MASS_POWER_BUILD
Final CharacterBodyType: Muscular
```

A 5'11", 245-pound running back may technically carry excess mass, but the `Heavy` body mesh is not a valid visual representation for a ball carrier. The tool should therefore store both values in the external sidecar.

Recommended internal body-composition categories:

```text
UNDER_MASSED_LEAN
SOFT
ATHLETIC
FUNCTIONALLY_MASSIVE
EXCESS_MASS
```

Recommended mapping:

```text
UNDER_MASSED_LEAN -> Freshman, only when position-eligible
SOFT -> Thin, only when position-eligible
ATHLETIC -> Standard, only when position-eligible
FUNCTIONALLY_MASSIVE -> Muscular
EXCESS_MASS -> Heavy, only when position-eligible
```

Position restrictions must override the direct mapping.

## Confidence and Rarity Controls

The classifier should return both a body type and a confidence value.

```text
CharacterBodyType: Muscular
Confidence: 0.84
```

Players near category thresholds should default toward the most common legal body type for their position.

Extreme body types should require strong evidence. The generator must enforce class-level rarity limits, especially for:

* Muscular wide receivers
* Muscular cornerbacks
* Muscular quarterbacks
* Thin tight ends
* Heavy kickers and punters

The goal is to select the most believable available in-game body mesh for the player's position, size, movement, strength, and football identity.

---

# 16. Weight Development

Weight should become dynamic and frame-aware.

Each player should have an ideal playing-weight range based on:

* Height
* Position
* Archetype
* Frame
* Body composition
* Initial athletic profile

Weight gain inside the ideal range should improve:

* Strength
* Functional power
* Anchor
* Contact resistance
* Durability

Weight gain beyond the ideal range should risk reducing:

* Speed
* Acceleration
* Agility
* Change of direction
* Stamina

Speed loss must be possible.

Agility loss must be possible.

Change-of-direction loss must be possible.

Development should not permanently push every rating upward.

A 6'7", 290-pound offensive tackle may gain substantial weight, but reaching 315 to 330 pounds in one offseason should be an upper-end result rather than the default outcome.

Weight gain should occur over multiple seasons unless the player has an unusually large frame and aggressive growth profile.

---

# 17. Appearance Tokens

Generated recruits usually do not expose fully decoded appearance customization.

The first generator should use existing appearance pairs.

Treat the following fields as a linked token:

```text
GenericHeadAssetName
+ PLYR_PORTRAIT
```

These values must stay paired.

Do not independently randomize the head token and portrait ID.

The initial appearance system should:

* Build a pool from existing generated recruits
* Preserve valid head and portrait pairings
* Avoid duplicates within the same class where practical
* Track body-type compatibility
* Maintain broad visual diversity
* Avoid touching real-player asset names
* Leave `CharacterVisuals` unchanged
* Leave portrait library paths unchanged
* Leave `PLYR_GENERICHEAD` unchanged unless testing proves otherwise

Future decoded appearance support should be implemented as a replaceable module.

The rest of the recruit generator must not depend on cracking `CharacterVisuals`.

---

# 18. Geographic and Identity Generation

Identity generation should remain separate from talent generation.

Recommended sequence:

```text
Home state
→ Hometown
→ Pipeline
→ Name
```

Football talent should be generated separately:

```text
Position
→ Archetype
→ Prospect profile
→ Ratings
```

Geography may influence:

* Recruit volume
* Position distribution
* Pipeline
* Evaluation confidence
* Frequency of elite prospects

Geography should not rigidly determine player quality.

---

# 19. Derived Rankings

`PositionRank` and `StateRank` must be recalculated after the full class is generated.

## Position rank

```text
Group recruits by Position.
Sort each group by NationalRank ascending.
Assign PositionRank beginning at 1.
```

## State rank

```text
Group recruits by PLYR_HOME_STATE.
Sort each group by NationalRank ascending.
Assign StateRank beginning at 1.
```

Position and state ranks should not be assigned independently before national ranking is finalized.

---

# 20. Production Grade and Unknown Fields

`ProductionGrade` should remain observational until its behavior is confirmed.

The tool should analyze its relationship with:

* National rank
* Overall rating
* Star rating
* Quality modifier
* Offer count
* Development trait

Do not build critical generation logic around `ProductionGrade` until correlation and controlled-edit testing establish its function.

The same caution applies to:

* `SkillGroupCap1-6`
* Physical ability encoding
* Mental ability encoding
* `IronManPosition`
* `Motivation1/2/3`
* `HIDDEN` quality modifier
* `CharacterVisuals`

Unknown fields should be preserved by default.

---

# 21. Recruit Generator Implementation Order

## Version 1: Core talent generation

Implement:

* Join Recruit and Player rows
* National rank
* Position rank
* State rank
* Star rating
* Position
* Archetype
* Height
* Weight
* Body composition
* Character body type
* Individual ratings
* Overall validation
* Development trait
* Gem and bust status
* Appearance-pair preservation

Preserve:

* Skill caps
* Abilities
* Mental abilities
* Production grade
* Motivations
* NIL
* Recruiting stages
* Top schools

## Version 2: Ceiling and progression system

Add:

* Skill-group cap decoding
* Cap generation by profile
* Freshman-baseline storage
* Career-growth budgets
* Post-offseason normalization
* Physical-rating growth limits
* Weight-development logic
* Rating regression where justified

## Version 3: Ability ecosystem

Add:

* Physical ability identity decoding
* Ability-tier decoding
* Archetype-specific ability pools
* Rating-threshold checks
* Ability scarcity controls
* Mental ability logic
* Ability normalization after progression

## Version 4: Recruiting personality and presentation

Add:

* NIL
* Motivations
* Dealbreakers
* Offers
* Top-school logic
* Production grade, once decoded
* Expanded appearance-token classification

---

# 22. Sidecar Data

The tool should create an external sidecar record for every generated recruit.

The game database may not preserve enough information to reconstruct the original design intent.

Store at least:

```json
{
  "player_id": 123456,
  "recruit_id": 7890,
  "generation_version": "0.1.0",
  "national_rank": 17,
  "position": "WR",
  "archetype": "Speedster",
  "profile_type": "RarePhysicalFreak",
  "body_composition": "LEAN",
  "readiness_score": 0.71,
  "physical_score": 0.96,
  "technical_score": 0.76,
  "mental_score": 0.63,
  "ceiling_score": 0.94,
  "evaluation_confidence": 0.82,
  "initial_overall": 84,
  "initial_weight": 188,
  "initial_body_type": "Freshman",
  "initial_ratings": {
    "SPD": 97,
    "ACC": 96,
    "DRR": 81,
    "RLS": 78
  },
  "dev_trait": "College_Star",
  "quality_modifier": "NORMAL",
  "ability_plan": [],
  "cap_plan": [],
  "appearance_token": "Generic_1532_P_T0075_H_1_2",
  "portrait_id": 1532
}
```

This sidecar will later support:

* Career-growth analysis
* Physical-rating normalization
* Weight-development tracking
* Ability validation
* Generator-version comparisons
* Outlier investigation

---

# 23. Validation

Every generated class must pass validation before database writeback.

## Referential validation

* Every `Recruit.Player` reference must resolve to a valid player row.
* Active recruits should not unintentionally share the same player row.

## Ranking validation

* National ranks should be unique.
* Position ranks should be unique within each position.
* State ranks should be unique within each state.
* Star ratings should match the configured national-rank cutoffs.

## Football validation

* Position and archetype combinations must be valid.
* Ratings must remain inside safe game limits.
* Overall rating should fall within the allowed rank-band range.
* Height and weight must be plausible for position and archetype.
* Weight encoding must be correct.
* Body type must match the actual visual rules.
* Front-seven and line players must not receive `Freshman`.
* `Freshman` should normally remain below 200 pounds except for approved tall-quarterback exceptions.

## Development validation

* Elite-development count must remain within the class budget.
* Star-development count must remain within the class budget.
* Low-ranked players must not be overloaded with Elite development.
* High starting overall and large growth ceiling should rarely coexist.

## Ability validation

Once abilities are implemented:

* Ability must be valid for position and archetype.
* Ability tier should respect the underlying ratings.
* Platinum count must remain within the class budget.
* Ability count should not simply track overall rating.

## Appearance validation

* Generic head and portrait pair must remain valid.
* Generated recruits should not accidentally receive real-player asset names.
* Duplicate appearance tokens should be minimized.
* Body type should remain separate from head-token classification.

---

# 24. Reporting

Each generated class should produce a validation report containing:

* Recruit count
* Average OVR by national-rank band
* OVR standard deviation by rank band
* Minimum and maximum OVR by rank band
* Number of freshmen rated 85 or higher
* Number rated 88 or higher
* Number rated 90
* Star-rating distribution
* Development-trait distribution
* Gem and bust distribution
* Position distribution
* Archetype distribution
* Body-type distribution
* Body-type distribution by position
* Ability-tier distribution, once implemented
* Height and weight outliers
* Invalid position or archetype combinations
* Duplicate rank errors
* Duplicate appearance-token count

The generator should also support deterministic seeds so the same class can be reproduced during testing.

---

# 25. Final Design Principle

The player’s freshman profile should remain recognizable throughout his career.

Fast players should generally remain fast.

Strong players should generally remain strong.

Polished players should enter closer to their ceilings.

Raw athletes should possess wider ranges of possible outcomes.

Elite players should feel elite because of identifiable ratings, archetypes, and abilities rather than generic overall inflation.

College development should refine and complete players far more often than it reinvents them.

Recruiting rankings should be imperfect but meaningfully predictive.

The system should create uncertainty without creating randomness detached from football logic.

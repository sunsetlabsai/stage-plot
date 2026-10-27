// Agent codesigner — system prompt, tool definitions, and types
// See docs/design-agent-codesigner.md for full design

import { POSITIONS } from './setlist';

export const SYSTEM_PROMPT = `You are a live sound engineer and stage manager assistant. You help musicians and engineers set up shows by translating natural language descriptions into structured technical configurations.

You understand:
- Stage positions — a 3x3 zone grid:
  Upstage:   USR (upstage right), USC (upstage center), USL (upstage left)
  Mid-stage: MSR (mid-stage right), MSC (mid-stage center), MSL (mid-stage left)
  Downstage: DSR (downstage right), DSC (downstage center), DSL (downstage left)

  Do NOT use PIT, FOH, or OTHER — those exist in the type system but are not renderable in the stage plot UI.

  Stage left/right is from the performer's perspective facing the audience. Audience's right = stage left = USL/MSL/DSL. Audience's left = stage right = USR/MSR/DSR.

- ZONE PHILOSOPHY: The stage plot is a spatial overview, not a detailed inventory. Each position is a ZONE, not a chair — and a zone can hold MORE THAN ONE occupant. Emit one stage-plot slot per distinct person or section; multiple slots may share the same pos when players genuinely stand together (e.g., two background vocalists at DSL, a three-piece horn line at USR). Each co-occupant is its own slot with its own name, role, mix, and linked inputs. Alternatively, when a section is large or its members are interchangeable for plot purposes, collapse it into a single named zone (e.g., name: "Horns", role: "Sax, Tpt, Tbn") and let the Input List carry per-player detail. Prefer individual occupants when the performers are few and individually named; collapse into a named section when the group is large, interchangeable, or individual detail belongs in the input list. Either way, fine per-player detail (mics, channels, stands) belongs in the Input List, not the stage plot.

  Multiple occupants may share a position — the renderer stacks every slot at a given pos into that zone's cell, so co-occupants render as separate chips rather than overwriting each other. With 9 zones plus stacking, any ensemble fits. For very large ensembles (big bands, orchestras), prefer section zones (e.g., "Brass" at MSR, "Strings" at MSL, "Woodwinds" at USR) and detail individuals in the Input List.

  The mid-stage row renders conditionally — it only appears when at least one MS position is occupied. For small bands (6 or fewer), prefer using just US + DS rows to keep the plot compact.

- Standard instrument mic'ing (SM57 on snare, kick drum mic, DI for bass and keys, SM58/Beta58 for vocals, condensers for overheads, clip mics for horns)
- Monitor mix conventions (lead vox gets their own mix, rhythm section often shares, horn sections often share)
- Power requirements (amps, keyboards, and pedal boards need power; acoustic drums, horns, and vocals typically don't)
- The "featured" flag is for the primary performer (usually lead vocalist) — highlighted visually on the stage plot

When the user describes their band, you should:
1. Set up stage positions based on their description, using the zone model — name distinct occupants individually (multiple may share a position) or collapse large/interchangeable sections into a single named zone; detail individuals in inputs
2. Call generate_show ONCE with the whole show — stagePlot, inputs and monitors together. A performer's stage slot and their input channels travel together: every person on the stage plot gets their inputs, and each of those inputs carries its performer's slotId. Give each stage-plot slot a tempId starting with "new:" (e.g. "new:dee") and set each input's slotId to that tempId. Only a source no performer owns (playback, click, talkback) has no slotId. Every stagePlot.mix of 1 or more must be the mix number of one of the monitors you send; 0 means "no monitor". Every person should be on a monitor mix.
3. Infer reasonable defaults for anything not specified (mic types, stand types, monitor groupings)
4. Auto-number channels sequentially (drums first, then bass, keys, guitars, horns, vocals — standard FOH convention)
5. Ask clarifying questions only when genuinely ambiguous

Monitor mix conventions:
- "Riddim mix" or "rhythm section mix" = drums, bass, and rhythm guitar/keys together
- "Shred mix" = lead guitar player's monitor, heavy on their own instrument plus drums/bass for timing
- When a mix is described as "shared" between two players (e.g., "keys mix shared w/ second guitar"), both players get the SAME mix number and the mix name should list both
- Lead vocalist always gets their own mix
- BGVs (background vocalists) typically share a mix
- Horn sections typically share a mix

Always use the provided tools to make changes. Never just describe what you would do — actually do it via tool calls.

The current show configuration is provided in each message.
- If the show has no stage plot, inputs or monitors yet, build it with generate_show.
- If the show already has content, generate_show REPLACES its stage plot, inputs and monitors (never the setlist, charts, notes or show info), and the user is asked to confirm first. Use it only when the user wants to start over or regenerate.
- For a targeted change to a show that already has content ("Beta 91 on the kick", "add a BGV mic for the bassist"), do NOT regenerate. Tell the user targeted AI edits are not available yet: they can make the change directly in the tables, or ask you to regenerate the whole show.
- You cannot change the setlist or charts. Point the user to setlist import or the Setlist tab.
- If a tool result says a change was refused, it tells you why. Fix the problem and try again, or ask the user.`;

const POS_ENUM = [...POSITIONS];

const STAGE_SLOT_SCHEMA = {
  type: 'object' as const,
  properties: {
    tempId: {
      type: 'string' as const,
      description: 'A handle for this new slot so inputs can reference it. MUST start with "new:" and be unique, e.g. "new:dee".',
    },
    name: { type: 'string' as const, description: 'Person or section name' },
    pos: { type: 'string' as const, enum: POS_ENUM, description: 'Stage zone position' },
    role: { type: 'string' as const, description: 'Instrument(s) or role description' },
    mix: { type: 'number' as const, description: 'Monitor mix number — a mix you send in monitors, or 0 for none' },
    power: { type: 'boolean' as const, description: 'Needs AC power drop' },
    featured: { type: 'boolean' as const, description: 'Primary performer highlight' },
  },
  required: ['tempId', 'name', 'pos', 'role', 'mix'],
};

const INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    ch: { type: 'number' as const, description: 'Channel number' },
    inst: { type: 'string' as const, description: 'Instrument or source' },
    mic: { type: 'string' as const, description: 'Microphone or DI type' },
    stand: { type: 'string' as const, description: 'Stand type' },
    notes: { type: 'string' as const, description: 'Notes (e.g., player name, position)' },
    slotId: { type: 'string' as const, description: 'The tempId of the stage-plot slot this input belongs to. Omit only for a source no performer owns (playback, click, talkback).' },
  },
  required: ['ch', 'inst', 'mic', 'stand'],
};

const MONITOR_SCHEMA = {
  type: 'object' as const,
  properties: {
    mix: { type: 'number' as const, description: 'Mix number' },
    name: { type: 'string' as const, description: 'Who gets this mix' },
    needs: { type: 'string' as const, description: 'What they need in the mix' },
    // Optional and free-text on purpose — suggestions, not a whitelist
    // (MONITOR_TYPES in lib/setlist.ts). Leaving it out is valid; the
    // viewer renders nothing rather than guessing.
    type: {
      type: 'string' as const,
      description:
        'How they hear it — typically "Wedge" or "IEM"; also "Side-fill", "Drum fill", "None". Omit if the user has not said.',
    },
  },
  required: ['mix', 'name', 'needs'],
};

export const TOOLS = [
  {
    // design-ai-op-contract §9.2: ONE whole-show create replaces the three
    // prompt-coordinated tools and the client cascade, so the model's lists are
    // the only writer and the plan is one approve card, all or nothing.
    name: 'generate_show',
    description:
      'Build the whole show — stage plot, input list and monitor mixes — in one call. On a show that already has content this REPLACES all three (the user confirms first); the setlist, charts, notes and show info are never touched.',
    input_schema: {
      type: 'object' as const,
      properties: {
        stagePlot: { type: 'array' as const, items: STAGE_SLOT_SCHEMA },
        inputs: { type: 'array' as const, items: INPUT_SCHEMA },
        monitors: { type: 'array' as const, items: MONITOR_SCHEMA },
      },
      required: ['stagePlot', 'inputs', 'monitors'],
    },
  },
  {
    name: 'update_notes',
    description: 'Replace the general notes section.',
    input_schema: {
      type: 'object' as const,
      properties: {
        notes: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              label: { type: 'string' as const, description: 'Note category (e.g., "Power", "Stands")' },
              text: { type: 'string' as const, description: 'Note content' },
            },
            required: ['label', 'text'],
          },
        },
      },
      required: ['notes'],
    },
  },
  {
    name: 'update_show_info',
    description: 'Update show metadata (band name, show name, date, venue, lineup).',
    input_schema: {
      type: 'object' as const,
      properties: {
        showInfo: {
          type: 'object' as const,
          properties: {
            bandName: { type: 'string' as const },
            showName: { type: 'string' as const, description: 'Show name for the file (e.g., "Friday Night at The Roxy")' },
            eventDate: { type: 'string' as const, description: 'ISO date (e.g., "2026-06-15")' },
            venue: { type: 'string' as const },
          },
        },
        lineup: { type: 'string' as const, description: 'e.g., "7-Piece Band"' },
      },
    },
  },
];

// Types for chat messages (mirrors Claude API message format)
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export type ToolName = 'generate_show' | 'update_notes' | 'update_show_info';

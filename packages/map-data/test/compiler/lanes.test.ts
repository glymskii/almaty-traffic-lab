import { describe, expect, it } from "vitest";
import { defaultTurns, parseTurnLanes } from "../../src/compiler/lanes.ts";
import { parseMaxspeed } from "../../src/compiler/speeds.ts";
import { compile, lanesOf, linkById, localSnapshot } from "./helpers.ts";

const noWarn = () => {
  throw new Error("unexpected warning");
};

describe("turn:lanes parsing", () => {
  it("maps OSM values onto TurnKind", () => {
    expect(parseTurnLanes("left;through|through|right", 1, noWarn)).toEqual([
      ["left", "through"],
      ["through"],
      ["right"],
    ]);
    expect(
      parseTurnLanes("slight_left|none||sharp_right;reverse|merge_to_right", 1, noWarn),
    ).toEqual([["left"], ["through"], ["through"], ["right", "uturn"], ["merge"]]);
    const warnings: string[] = [];
    expect(parseTurnLanes("bogus|through", 5, (m) => warnings.push(m))).toEqual([
      ["through"],
      ["through"],
    ]);
    expect(warnings).toEqual(['way 5: unknown turn:lanes value "bogus" (treated as through)']);
  });

  it("assigns default turns by lane count", () => {
    expect(defaultTurns(1, false)).toEqual([["left", "through", "right"]]);
    expect(defaultTurns(2, false)).toEqual([
      ["left", "through"],
      ["through", "right"],
    ]);
    expect(defaultTurns(4, false)).toEqual([
      ["left", "through"],
      ["through"],
      ["through"],
      ["through", "right"],
    ]);
    expect(defaultTurns(2, true)).toEqual([["through"], ["through", "right"]]);
    expect(defaultTurns(1, true)).toEqual([["through", "right"]]);
  });
});

describe("maxspeed parsing", () => {
  it("understands numbers, units and named limits", () => {
    expect(parseMaxspeed("40")).toBe(40);
    expect(parseMaxspeed(" 60 ")).toBe(60);
    expect(parseMaxspeed("50 km/h")).toBe(50);
    expect(parseMaxspeed("30 mph")).toBe(48);
    expect(parseMaxspeed("RU:urban")).toBe(60);
    expect(parseMaxspeed("KZ:living_street")).toBe(20);
    expect(parseMaxspeed("none")).toBeUndefined();
    expect(parseMaxspeed("signals")).toBeUndefined();
  });
});

const twoWay = (id: number, tags: Record<string, string>, nodes: number[]) => ({ id, tags, nodes });
const straight = { 1: [-300, 0] as [number, number], 2: [300, 0] as [number, number] };

describe("lane counts", () => {
  it("splits `lanes` on two-way streets with the bigger half forward", () => {
    const net = compile(
      localSnapshot(straight, [twoWay(1, { highway: "secondary", lanes: "3" }, [1, 2])]),
    ).network;
    expect(lanesOf(net, linkById(net, "w1_0_f"))).toHaveLength(2);
    expect(lanesOf(net, linkById(net, "w1_0_b"))).toHaveLength(1);
    expect(linkById(net, "w1_0_f").provenance.laneIds).toBe("osm");
    // forward is shifted 3.5 m right (south), backward 1.75 m right of its own travel (north)
    expect(linkById(net, "w1_0_f").geometry[0]?.[1]).toBeCloseTo(-3.5, 1);
    expect(linkById(net, "w1_0_b").geometry[0]?.[1]).toBeCloseTo(1.75, 1);
  });

  it("uses lanes:forward / lanes:backward directly and derives the other from `lanes`", () => {
    const explicit = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "secondary", "lanes:forward": "3", "lanes:backward": "2" }, [1, 2]),
      ]),
    ).network;
    expect(lanesOf(explicit, linkById(explicit, "w1_0_f"))).toHaveLength(3);
    expect(lanesOf(explicit, linkById(explicit, "w1_0_b"))).toHaveLength(2);
    const derived = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "secondary", lanes: "5", "lanes:forward": "3" }, [1, 2]),
      ]),
    ).network;
    expect(lanesOf(derived, linkById(derived, "w1_0_b"))).toHaveLength(2);
    expect(linkById(derived, "w1_0_b").provenance.laneIds).toBe("osm");
  });

  it("subtracts a stale lanes:backward from `lanes` on one-way streets", () => {
    const net = compile(
      localSnapshot(straight, [
        twoWay(
          1,
          {
            highway: "secondary",
            oneway: "yes",
            lanes: "7",
            "lanes:backward": "3",
            "turn:lanes:forward": "left|through|through|right",
          },
          [1, 2],
        ),
      ]),
    ).network;
    const lanes = lanesOf(net, linkById(net, "w1_0_f"));
    expect(lanes).toHaveLength(4);
    expect(lanes.map((l) => l.turns)).toEqual([["left"], ["through"], ["through"], ["right"]]);
  });

  it("splits `lanes` by the turn:lanes:<dir> entry counts when they are consistent", () => {
    const net = compile(
      localSnapshot(straight, [
        twoWay(
          1,
          { highway: "tertiary", lanes: "4", "turn:lanes:backward": "left|through;left|right" },
          [1, 2],
        ),
      ]),
    ).network;
    expect(lanesOf(net, linkById(net, "w1_0_f"))).toHaveLength(1);
    const back = lanesOf(net, linkById(net, "w1_0_b"));
    expect(back.map((l) => l.turns)).toEqual([["left"], ["left", "through"], ["right"]]);
    expect(back[0]?.kind).toBe("turn_pocket");
    expect(linkById(net, "w1_0_b").provenance.laneIds).toBe("osm");
  });

  it("falls back to class defaults with provenance default", () => {
    const net = compile(
      localSnapshot(straight, [twoWay(1, { highway: "trunk", name: "Аль-Фараби" }, [1, 2])]),
    ).network;
    const link = linkById(net, "w1_0_f");
    expect(lanesOf(net, link)).toHaveLength(3);
    expect(link.provenance).toEqual({ speedLimitKph: "default", laneIds: "default" });
    expect(link.speedLimitKph).toBe(80);
  });

  it("adopts the lane count from turn:lanes when `lanes` is missing", () => {
    const net = compile(
      localSnapshot(straight, [
        twoWay(
          1,
          { highway: "residential", oneway: "yes", "turn:lanes": "left|through|right" },
          [1, 2],
        ),
      ]),
    ).network;
    const link = linkById(net, "w1_0_f");
    expect(lanesOf(net, link).map((l) => l.turns)).toEqual([["left"], ["through"], ["right"]]);
    expect(link.provenance.laneIds).toBe("osm");
  });

  it("trusts turn:lanes over a contradicting `lanes` on one-way streets", () => {
    const report = compile(
      localSnapshot(straight, [
        twoWay(
          1,
          { highway: "secondary", oneway: "yes", lanes: "2", "turn:lanes": "left|through|right" },
          [1, 2],
        ),
      ]),
    );
    const link = linkById(report.network, "w1_0_f");
    expect(lanesOf(report.network, link).map((l) => l.turns)).toEqual([
      ["left"],
      ["through"],
      ["right"],
    ]);
    expect(link.provenance.laneIds).toBe("osm");
    expect(report.warnings).toContain(
      "way 1: lanes=2 contradicts turn:lanes with 3 entries on a one-way street; using turn:lanes",
    );
  });

  it("ignores turn:lanes that contradict an explicit lane count on two-way streets and warns", () => {
    const report = compile(
      localSnapshot(straight, [
        twoWay(
          1,
          {
            highway: "secondary",
            "lanes:forward": "2",
            "lanes:backward": "2",
            "turn:lanes:forward": "left|through|right",
          },
          [1, 2],
        ),
      ]),
    );
    const link = linkById(report.network, "w1_0_f");
    expect(lanesOf(report.network, link).map((l) => l.turns)).toEqual([
      ["left", "through"],
      ["through", "right"],
    ]);
    expect(report.warnings).toContain(
      "way 1: turn:lanes has 3 entries but the forward direction has 2 lanes; turn:lanes ignored",
    );
  });
});

describe("left pockets", () => {
  const signalCross = {
    1: [-300, 0] as [number, number],
    2: [0, 0] as [number, number],
    3: [300, 0] as [number, number],
    4: [0, -100] as [number, number],
    5: [0, 100] as [number, number],
  };
  const signals = { 2: { highway: "traffic_signals" } };

  it("opens a 60 m pocket on signalized approaches of major streets without turn:lanes", () => {
    const net = compile(
      localSnapshot(
        signalCross,
        [
          twoWay(1, { highway: "primary", lanes: "4" }, [1, 2, 3]),
          twoWay(2, { highway: "tertiary", lanes: "4" }, [4, 2, 5]),
        ],
        signals,
      ),
    ).network;
    const approach = linkById(net, "w1_0_f");
    expect(approach.toNodeId).toBe("n2");
    const lanes = lanesOf(net, approach);
    expect(lanes.map((l) => l.kind)).toEqual(["turn_pocket", "general", "general"]);
    expect(lanes[0]?.startS).toBeCloseTo(approach.lengthM - 60, 0);
    expect(lanes[0]?.provenance).toEqual({ turns: "default", startS: "default" });
    expect(approach.provenance.laneIds).toBe("default");
    // The extra lane widens the carriageway: 3 lanes → 5.25 m off the axis instead of 3.5 m.
    expect(approach.geometry[0]?.[1]).toBeCloseTo(-5.25, 1);
    // leaving the junction: no pocket
    expect(lanesOf(net, linkById(net, "w1_1_f")).map((l) => l.kind)).toEqual([
      "general",
      "general",
    ]);
    // tertiary: class too low for the rule
    const tertiary = linkById(net, "w2_0_f");
    expect(tertiary.toNodeId).toBe("n2");
    expect(lanesOf(net, tertiary).map((l) => l.kind)).toEqual(["general", "general"]);
  });

  it("needs a signalized node, at least two lanes and 120 m", () => {
    const plain = compile(
      localSnapshot(signalCross, [
        twoWay(1, { highway: "primary", lanes: "4" }, [1, 2, 3]),
        twoWay(2, { highway: "primary", lanes: "4" }, [4, 2, 5]),
      ]),
    ).network;
    expect(lanesOf(plain, linkById(plain, "w1_0_f")).every((l) => l.kind === "general")).toBe(true);
    const short = compile(
      localSnapshot(
        signalCross,
        [
          twoWay(1, { highway: "primary", lanes: "4" }, [1, 2, 3]),
          twoWay(2, { highway: "primary", lanes: "4" }, [4, 2, 5]),
        ],
        signals,
      ),
    ).network;
    expect(lanesOf(short, linkById(short, "w2_0_f")).every((l) => l.kind === "general")).toBe(true);
    const single = compile(
      localSnapshot(
        signalCross,
        [
          twoWay(1, { highway: "primary", lanes: "2" }, [1, 2, 3]),
          twoWay(2, { highway: "primary", lanes: "4" }, [4, 2, 5]),
        ],
        signals,
      ),
    ).network;
    expect(lanesOf(single, linkById(single, "w1_0_f")).every((l) => l.kind === "general")).toBe(
      true,
    );
  });

  it("turns a tagged left-only leftmost lane into a pocket of 40% of a short link", () => {
    const net = compile(
      localSnapshot({ 1: [-150, 0], 2: [0, 0] }, [
        twoWay(1, { highway: "secondary", oneway: "yes", "turn:lanes": "left|through" }, [1, 2]),
      ]),
    ).network;
    const link = linkById(net, "w1_0_f");
    const lanes = lanesOf(net, link);
    expect(lanes[0]?.kind).toBe("turn_pocket");
    expect(lanes[0]?.startS).toBeCloseTo(link.lengthM * 0.6, 0);
    expect(lanes[0]?.provenance).toEqual({ turns: "osm", startS: "default" });
    expect(link.provenance.laneIds).toBe("osm");
  });

  it("never turns the only lane into a pocket", () => {
    const net = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "secondary_link", oneway: "yes", "turn:lanes": "left" }, [1, 2]),
      ]),
    ).network;
    const lanes = lanesOf(net, linkById(net, "w1_0_f"));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.kind).toBe("general");
    expect(lanes[0]?.turns).toEqual(["left"]);
  });
});

describe("bus lanes", () => {
  it("adds a bus lane on top of default lane counts (busway=lane, both directions)", () => {
    const report = compile(
      localSnapshot(straight, [twoWay(1, { highway: "secondary", busway: "lane" }, [1, 2])]),
    );
    const net = report.network;
    for (const id of ["w1_0_f", "w1_0_b"]) {
      const link = linkById(net, id);
      const lanes = lanesOf(net, link);
      expect(lanes.map((l) => l.kind)).toEqual(["general", "general", "bus"]);
      expect(link.provenance.laneIds).toBe("default");
      expect(lanes[2]?.busLane?.carsMayEnterForRightTurnWithinM).toBe(50);
    }
    expect(report.assumptions.find((a) => a.kind === "bus_lane_hours_default")?.count).toBe(2);
  });

  it("converts the rightmost tagged lane (lanes:psv, busway:right) and respects sides", () => {
    const net = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "secondary", lanes: "6", "busway:right": "lane" }, [1, 2]),
      ]),
    ).network;
    expect(lanesOf(net, linkById(net, "w1_0_f")).map((l) => l.kind)).toEqual([
      "general",
      "general",
      "bus",
    ]);
    expect(lanesOf(net, linkById(net, "w1_0_b")).every((l) => l.kind === "general")).toBe(true);
    const left = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "secondary", lanes: "6", "busway:left": "lane" }, [1, 2]),
      ]),
    ).network;
    expect(lanesOf(left, linkById(left, "w1_0_f")).every((l) => l.kind === "general")).toBe(true);
    expect(lanesOf(left, linkById(left, "w1_0_b")).map((l) => l.kind)).toEqual([
      "general",
      "general",
      "bus",
    ]);
    const psv = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "primary", oneway: "yes", lanes: "3", "lanes:psv": "1" }, [1, 2]),
      ]),
    ).network;
    expect(lanesOf(psv, linkById(psv, "w1_0_f")).map((l) => l.kind)).toEqual([
      "general",
      "general",
      "bus",
    ]);
  });

  it("accepts busway:left=yes (Almaty tagging) and splits an undirected lanes:psv count", () => {
    const report = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "tertiary", lanes: "4", "busway:left": "yes" }, [1, 2]),
        twoWay(2, { highway: "tertiary", lanes: "4", "lanes:psv": "2" }, [2, 1]),
      ]),
    );
    const net = report.network;
    expect(lanesOf(net, linkById(net, "w1_0_f")).every((l) => l.kind === "general")).toBe(true);
    expect(lanesOf(net, linkById(net, "w1_0_b")).map((l) => l.kind)).toEqual(["general", "bus"]);
    expect(lanesOf(net, linkById(net, "w2_0_f")).map((l) => l.kind)).toEqual(["general", "bus"]);
    expect(lanesOf(net, linkById(net, "w2_0_b")).map((l) => l.kind)).toEqual(["general", "bus"]);
    expect(report.warnings.filter((w) => w.startsWith("way"))).toEqual([]);
  });

  it("reads bus:lanes and moves a misplaced designated lane to the right with a warning", () => {
    const report = compile(
      localSnapshot(straight, [
        twoWay(
          1,
          { highway: "primary", oneway: "yes", "bus:lanes": "designated|yes|yes", name: "Абая" },
          [1, 2],
        ),
      ]),
    );
    const net = report.network;
    const link = linkById(net, "w1_0_f");
    expect(link.provenance.laneIds).toBe("osm");
    expect(lanesOf(net, link).map((l) => l.kind)).toEqual(["general", "general", "bus"]);
    expect(report.warnings).toContain(
      "way 1: bus:lanes designates lane 1 of 3 (not the rightmost); modelled as the rightmost lane",
    );
    expect(report.assumptions.find((a) => a.kind === "bus_lane_position_assumed")?.count).toBe(1);
  });

  it("keeps a general lane next to a bus lane on single-lane streets", () => {
    const report = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "residential", oneway: "yes", lanes: "1", busway: "lane" }, [1, 2]),
      ]),
    );
    const link = linkById(report.network, "w1_0_f");
    expect(lanesOf(report.network, link).map((l) => l.kind)).toEqual(["general", "bus"]);
    expect(link.provenance.laneIds).toBe("default");
  });
});

describe("speeds", () => {
  it("prefers maxspeed:<direction> and warns on values it cannot use", () => {
    const report = compile(
      localSnapshot(straight, [
        twoWay(1, { highway: "tertiary", maxspeed: "50", "maxspeed:backward": "30" }, [1, 2]),
        twoWay(2, { highway: "tertiary", maxspeed: "none" }, [2, 1]),
      ]),
    );
    const net = report.network;
    expect(linkById(net, "w1_0_f").speedLimitKph).toBe(50);
    expect(linkById(net, "w1_0_b").speedLimitKph).toBe(30);
    expect(linkById(net, "w2_0_f").speedLimitKph).toBe(60);
    expect(linkById(net, "w2_0_f").provenance.speedLimitKph).toBe("default");
    expect(report.warnings).toContain(
      'way 2: cannot interpret maxspeed="none"; using the class default',
    );
  });
});

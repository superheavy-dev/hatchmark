import type { MapData, MapMatch, MetricInfo } from "../src/compiler/dashboard-data.js";
import { classOf, type MapScaleSpec, mapScale } from "../src/compiler/map-scale.js";
import { GEOGRAPHY_DATA } from "../src/geo/index.js";
import type { GeographyId } from "../src/spec/index.js";
import { dashboard, METRICS, OCT } from "./fixtures.js";
import type { GalleryVariant } from "./variants.js";

const MAP_METRICS: Record<string, MetricInfo> = {
  revenue_per_customer: {
    name: "revenue_per_customer",
    label: "Revenue per customer",
    format: { type: "currency", currency: "USD", decimals: 2 },
    better: "up",
  },
  conversion_rate: {
    name: "conversion_rate",
    label: "Conversion rate",
    format: { type: "percent", decimals: 1 },
    better: "up",
  },
  revenue_growth: {
    name: "revenue_growth",
    label: "Revenue growth",
    format: { type: "percent", decimals: 1 },
    better: "up",
  },
  margin_vs_target: {
    name: "margin_vs_target",
    label: "Margin vs target",
    format: { type: "percent", decimals: 1 },
    better: "up",
  },
};

const noise = (id: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 5_000 - 1;
};

const STATE_WEIGHT: Record<string, number> = {
  CA: 39,
  TX: 30,
  FL: 22,
  NY: 20,
  PA: 13,
  IL: 12.5,
  OH: 11.8,
  GA: 11,
  NC: 10.8,
  MI: 10,
};

interface Spec {
  id: string;
  title: string;
  geo: GeographyId;
  metric: string;
  value: (id: string) => number | null;
  scale?: MapScaleSpec;
  additive?: boolean;
  pair?: "bars" | "none";
  span?: number;
  extra?: MapMatch[];
  skip?: string[];
  only?: number;
  empty?: boolean;
}

function block(s: Spec): MapData {
  const geography = GEOGRAPHY_DATA[s.geo];
  const ids = geography.regions
    .map((r) => r.id)
    .filter((id, i) => !(s.skip ?? []).includes(id) && (s.only === undefined || i % s.only === 0));
  const raw = s.empty ? [] : ids.map((id) => ({ id, value: s.value(id) }));
  const values = raw.flatMap((r) => (r.value === null ? [] : [r.value]));
  const scale = mapScale(values, s.scale);
  const total = s.additive
    ? values.reduce((t, v) => t + v, 0)
    : values.length === 0
      ? null
      : values.reduce((t, v) => t + v, 0) / values.length;
  const regions = raw
    .sort(
      (a, b) =>
        (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY) ||
        a.id.localeCompare(b.id),
    )
    .map((r) => {
      if (r.value === null) return { id: r.id, value: null };
      const value = r.value;
      return {
        id: r.id,
        value,
        rank: values.filter((v) => v > value).length + 1,
        ...(s.additive && total ? { share: value / total } : {}),
        class: classOf(value, scale.breaks),
      };
    });
  return {
    type: "map",
    id: s.id,
    title: s.title,
    span: s.span ?? 12,
    geo: s.geo,
    metric: s.metric,
    column: s.geo === "us-states" ? "state" : "country",
    pair: s.pair ?? "bars",
    regions,
    total,
    additive: s.additive ?? false,
    scale,
    match: [
      ...regions.map((r) => ({
        key: r.id,
        region: r.id,
        rows: 40 + Math.round(noise(r.id, 9) * 30 + 30),
        value: r.value,
      })),
      ...(s.extra ?? []),
    ],
    window: OCT,
    ...(s.empty ? { empty: "no_data" as const } : {}),
  };
}

const map = (variant: string, title: string, s: Spec): GalleryVariant => {
  const data = dashboard(variant, title, [block(s)]);
  return {
    component: "map",
    variant,
    title,
    data: { ...data, metrics: { ...METRICS, ...MAP_METRICS } },
  };
};

const rpc = (id: string) =>
  Math.round((92 + noise(id, 1) * 38 + (id === "DC" ? 60 : 0)) * 100) / 100;
const conversion = (id: string) => Math.round((0.028 + noise(id, 2) * 0.016) * 10_000) / 10_000;
const growth = (id: string) => Math.round(noise(id, 3) * 0.18 * 1000) / 1000;
const stateRevenue = (id: string) =>
  Math.round((STATE_WEIGHT[id] ?? 1.5 + Math.abs(noise(id, 4)) * 7) * 41_000);

export const MAPS: GalleryVariant[] = [
  map("map-us-rate", "US states: revenue per customer, quantile, 5 classes", {
    id: "map_us_rate",
    title: "Revenue per customer by state",
    geo: "us-states",
    metric: "revenue_per_customer",
    value: rpc,
    skip: ["WY", "ND"],
  }),
  map("map-world-rate", "World: conversion rate, quantile, 5 classes, with values not on the map", {
    id: "map_world_rate",
    title: "Conversion rate by country",
    geo: "world-countries",
    metric: "conversion_rate",
    value: conversion,
    only: 2,
    extra: [
      { key: "Singapore", region: null, rows: 214, value: 0.041 },
      { key: "Congo", region: null, rows: 31, value: 0.018 },
      { key: "Untited Kingdom", region: null, rows: 6, value: 0.022 },
    ],
  }),
  map("map-us-diverging", "Diverging threshold: revenue growth, midpoint 0, 6 classes", {
    id: "map_us_growth",
    title: "Revenue growth vs last year by state",
    geo: "us-states",
    metric: "revenue_growth",
    value: growth,
    scale: { type: "threshold", breaks: [-0.1, -0.03, 0, 0.03, 0.1], midpoint: 0 },
  }),
  map("map-world-diverging", "Diverging, odd classes: margin vs target, midpoint 0, 5 classes", {
    id: "map_world_margin",
    title: "Operating margin vs target by country",
    geo: "world-countries",
    metric: "margin_vs_target",
    value: (id) => Math.round(noise(id, 5) * 0.12 * 1000) / 1000,
    scale: { type: "threshold", breaks: [-0.06, -0.02, 0.02, 0.06], midpoint: 0 },
    only: 3,
  }),
  map("map-us-sum", "A sum on a filled map mostly shows where people live; map a rate instead", {
    id: "map_us_sum",
    title: "Revenue by state",
    geo: "us-states",
    metric: "revenue",
    value: stateRevenue,
    additive: true,
    extra: [{ key: "Guam", region: null, rows: 12, value: 4_210 }],
  }),
  map("map-us-linear-alone", "Linear scale, 7 classes, map alone", {
    id: "map_us_linear",
    title: "Conversion rate by state",
    geo: "us-states",
    metric: "conversion_rate",
    value: conversion,
    scale: { type: "linear", classes: 7 },
    pair: "none",
  }),
  map("map-us-narrow", "Narrow card (span 6): the bar list moves under the map", {
    id: "map_us_narrow",
    title: "Revenue per customer by state",
    geo: "us-states",
    metric: "revenue_per_customer",
    value: rpc,
    span: 6,
    scale: { classes: 3 },
  }),
  map("map-world-empty", "Empty period", {
    id: "map_world_empty",
    title: "Conversion rate by country",
    geo: "world-countries",
    metric: "conversion_rate",
    value: conversion,
    empty: true,
  }),
];

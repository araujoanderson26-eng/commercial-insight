import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import {
  change,
  deltaTitle,
  metrics,
  pretty,
  type Metric,
  type Report,
} from "../../shared/domain";
import { absoluteChange, monthName } from "../ui";

echarts.use([
  BarChart,
  LineChart,
  TooltipComponent,
  GridComponent,
  DataZoomComponent,
  LegendComponent,
  MarkLineComponent,
  SVGRenderer,
]);

export type SmartChartMode = "primary" | "secondary";

export type SmartChartSelection = {
  key: string;
  name: string;
  isMonth: boolean;
  canDrill: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateLabel(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars - 1) + "…" : value;
}

export function SmartChart({
  r,
  metric = r.plan.metric,
  mode = "primary",
  onSelectPoint,
  activeKey,
  onZoomChange,
  resetZoomNonce = 0,
}: {
  r: Report;
  metric?: Metric;
  mode?: SmartChartMode;
  onSelectPoint?: (item: SmartChartSelection) => void;
  activeKey?: string;
  onZoomChange?: (zoomed: boolean) => void;
  resetZoomNonce?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const selectRef = useRef(onSelectPoint);
  const zoomCallbackRef = useRef(onZoomChange);
  const rowsRef = useRef(r.rows);
  selectRef.current = onSelectPoint;
  zoomCallbackRef.current = onZoomChange;
  rowsRef.current = r.rows;

  const [containerWidth, setContainerWidth] = useState(720);
  const isMonth = r.plan.group === "month";
  const isCompact = containerWidth < 520;
  const visibleLimit = isCompact ? 6 : 8;
  const hasRankZoom = !isMonth && r.rows.length > visibleLimit;
  const hasMonthZoom = isMonth && r.rows.length > (isCompact ? 5 : 8);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const updateWidth = () => {
      const next = el.clientWidth;
      if (next > 0) setContainerWidth((prev) => (Math.abs(prev - next) > 6 ? next : prev));
    };
    updateWidth();
    const chart = echarts.init(el, undefined, { renderer: "svg" });
    chartRef.current = chart;

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            updateWidth();
            chart.resize();
          })
        : null;
    ro?.observe(el);

    const onPrint = () => chart.resize();
    window.addEventListener("beforeprint", onPrint);

    chart.on("click", (params) => {
      const index = typeof params.dataIndex === "number" ? params.dataIndex : -1;
      const row = rowsRef.current[index];
      if (!row || !selectRef.current) return;
      selectRef.current({
        key: r.plan.group === "month" ? row.name : (row.key ?? row.name),
        name: row.name,
        isMonth: r.plan.group === "month",
        canDrill: row.canDrill !== false,
      });
    });

    chart.on("datazoom", () => {
      if (!zoomCallbackRef.current) return;
      const opt = chart.getOption() as {
        dataZoom?: { start?: number; end?: number; startValue?: number; endValue?: number }[];
      };
      const zoom = opt.dataZoom?.[0];
      if (!zoom) return;
      if (r.plan.group === "month") {
        const zoomed = (zoom.start ?? 0) > 0.5 || (zoom.end ?? 100) < 99.5;
        zoomCallbackRef.current(zoomed);
      } else {
        const zoomed = (zoom.startValue ?? 0) > 0;
        zoomCallbackRef.current(zoomed);
      }
    });

    return () => {
      window.removeEventListener("beforeprint", onPrint);
      ro?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [r.plan.group]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const rows = r.rows;
    const labels = rows.map((row) => (isMonth ? monthName(row.name) : row.name));
    const keys = rows.map((row) => (isMonth ? row.name : (row.key ?? row.name)));

    const tooltipFormatter = (rawParams: unknown) => {
      const items = Array.isArray(rawParams) ? rawParams : [rawParams];
      const first = items[0] as { dataIndex?: number } | undefined;
      const index = typeof first?.dataIndex === "number" ? first.dataIndex : -1;
      const row = rows[index];
      if (!row) return "";
      const pair = row.values[metric];
      const deltaPct = change(pair, metric);
      const titleText = isMonth ? monthName(row.name, true) : row.name;
      const diffText = absoluteChange(pair, metric);
      const pctText =
        deltaPct === null
          ? pair.previous !== null && pair.previous < 0
            ? "Base anterior negativa"
            : pair.previous === 0
              ? "Base anterior zero"
              : "Sem base comparável"
          : deltaTitle(deltaPct, metric);
      const isFavorable =
        pair.current !== null &&
        pair.previous !== null &&
        pair.current !== pair.previous &&
        (pair.current > pair.previous) === metrics[metric].up;
      const isUnfavorable =
        pair.current !== null &&
        pair.previous !== null &&
        pair.current !== pair.previous &&
        (pair.current > pair.previous) !== metrics[metric].up;
      const badgeColor = isFavorable ? "#14714e" : isUnfavorable ? "#aa3045" : "#516176";
      const badgeBg = isFavorable ? "#e4f5ee" : isUnfavorable ? "#fdebee" : "#edf1f5";

      return [
        `<div style="min-width:190px;max-width:270px;font-family:Inter,system-ui,sans-serif;font-size:12px;line-height:1.45;color:#111e34;white-space:normal">`,
        `<div style="font-weight:700;margin-bottom:6px;word-break:break-word">${escapeHtml(titleText)}</div>`,
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#5c6980">Período:</span><strong>${escapeHtml(pretty(pair.current, metric))}</strong></div>`,
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#5c6980">Ano anterior:</span><span>${escapeHtml(pretty(pair.previous, metric))}</span></div>`,
        `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px;padding-top:4px;border-top:1px solid #e7ecf4"><span style="color:#5c6980">Diferença:</span><strong>${escapeHtml(diffText)}</strong></div>`,
        `<div style="margin-top:5px"><span style="display:inline-block;padding:2px 6px;border-radius:5px;font-size:11px;font-weight:650;background:${badgeBg};color:${badgeColor}">${escapeHtml(pctText)}</span></div>`,
        row.canDrill !== false
          ? `<div style="margin-top:5px;font-size:10px;color:#6750d8">Clique para filtrar por este item</div>`
          : "",
        `</div>`,
      ].join("");
    };

    const baseTooltip: echarts.EChartsCoreOption["tooltip"] = {
      trigger: "axis",
      confine: true,
      axisPointer: { type: isMonth && mode === "primary" ? "line" : "shadow" },
      backgroundColor: "rgba(255, 255, 255, 0.98)",
      borderColor: "#d9e1ef",
      borderWidth: 1,
      padding: [10, 12],
      extraCssText: "box-shadow:0 10px 26px rgba(10,28,54,0.14);border-radius:11px;",
      formatter: tooltipFormatter,
    };

    let option: echarts.EChartsCoreOption;

    if (isMonth) {
      const currentSeries = rows.map((row, idx) => {
        const value = row.values[metric].current;
        const selected = activeKey ? keys[idx] === activeKey : false;
        return {
          value,
          symbolSize: selected ? 10 : 6,
          itemStyle: {
            color: selected ? "#3922b2" : "#5942d6",
            opacity: activeKey && !selected ? 0.48 : 1,
            borderColor: selected ? "#55deec" : "#ffffff",
            borderWidth: selected ? 2 : 1.5,
          },
        };
      });
      const previousSeries = rows.map((row) => row.values[metric].previous);

      option = {
        animation: !reducedMotion,
        animationDuration: 320,
        tooltip: baseTooltip,
        grid: {
          left: isCompact ? 50 : 68,
          right: isCompact ? 10 : 16,
          top: 14,
          bottom: hasMonthZoom ? 46 : 26,
          containLabel: false,
        },
        xAxis: {
          type: "category",
          data: labels,
          boundaryGap: mode === "secondary",
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: "#627089",
            fontSize: isCompact ? 10 : 11,
            hideOverlap: true,
            formatter: (v: string) => truncateLabel(v, isCompact ? 8 : 12),
          },
        },
        yAxis: {
          type: "value",
          splitNumber: isCompact ? 4 : 5,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: "#e5eaf3", type: "dashed" } },
          axisLabel: {
            color: "#627089",
            fontSize: isCompact ? 10 : 11,
            formatter: (val: number) => pretty(Number(val), metric, true),
          },
        },
        dataZoom: hasMonthZoom
          ? [
              { type: "inside", xAxisIndex: 0, filterMode: "none" },
              {
                type: "slider",
                xAxisIndex: 0,
                height: 16,
                bottom: 4,
                showDetail: false,
                borderColor: "#e2e7f2",
                fillerColor: "rgba(89, 66, 214, 0.16)",
                handleSize: "90%",
              },
            ]
          : [],
        series:
          mode === "primary"
            ? [
                {
                  name: "Ano anterior",
                  type: "line",
                  data: previousSeries,
                  smooth: 0.25,
                  showSymbol: false,
                  connectNulls: false,
                  lineStyle: { color: "#98acc8", width: 2, type: "dashed" },
                  itemStyle: { color: "#98acc8" },
                },
                {
                  name: "Período selecionado",
                  type: "line",
                  data: currentSeries,
                  smooth: 0.25,
                  connectNulls: false,
                  lineStyle: { color: "#5942d6", width: 3 },
                  areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                      { offset: 0, color: "rgba(89, 66, 214, 0.22)" },
                      { offset: 1, color: "rgba(89, 66, 214, 0.01)" },
                    ]),
                  },
                },
              ]
            : [
                {
                  name: "Ano anterior",
                  type: "bar",
                  data: previousSeries,
                  barMaxWidth: isCompact ? 12 : 18,
                  itemStyle: { color: "#b7c7de", borderRadius: [4, 4, 0, 0] },
                },
                {
                  name: "Período selecionado",
                  type: "bar",
                  data: currentSeries,
                  barMaxWidth: isCompact ? 12 : 18,
                  itemStyle: { borderRadius: [4, 4, 0, 0] },
                },
              ],
      };
    } else if (mode === "primary") {
      const currentBars = rows.map((row, idx) => {
        const value = row.values[metric].current;
        const selected = activeKey ? keys[idx] === activeKey : false;
        return {
          value,
          itemStyle: {
            color: selected ? "#3922b2" : "#5942d6",
            opacity: activeKey && !selected ? 0.4 : 1,
            borderRadius: value !== null && value < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0],
          },
        };
      });
      const previousBars = rows.map((row, idx) => {
        const value = row.values[metric].previous;
        const selected = activeKey ? keys[idx] === activeKey : false;
        return {
          value,
          itemStyle: {
            color: "#b8c8df",
            opacity: activeKey && !selected ? 0.4 : 1,
            borderRadius: value !== null && value < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0],
          },
        };
      });

      option = {
        animation: !reducedMotion,
        animationDuration: 300,
        tooltip: baseTooltip,
        grid: {
          left: isCompact ? 98 : 154,
          right: hasRankZoom ? 26 : 14,
          top: 8,
          bottom: 24,
          containLabel: false,
        },
        xAxis: {
          type: "value",
          splitNumber: isCompact ? 3 : 4,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: "#e5eaf3", type: "dashed" } },
          axisLabel: {
            color: "#627089",
            fontSize: 10,
            formatter: (val: number) => pretty(Number(val), metric, true),
          },
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: labels,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: "#33435a",
            fontSize: isCompact ? 10 : 11,
            width: isCompact ? 90 : 144,
            overflow: "truncate",
            formatter: (val: string) => truncateLabel(val, isCompact ? 14 : 23),
          },
        },
        dataZoom: hasRankZoom
          ? [
              {
                type: "inside",
                yAxisIndex: 0,
                startValue: 0,
                endValue: visibleLimit - 1,
                zoomOnMouseWheel: false,
                moveOnMouseWheel: true,
                moveOnMouseMove: true,
              },
              {
                type: "slider",
                yAxisIndex: 0,
                right: 2,
                width: 12,
                startValue: 0,
                endValue: visibleLimit - 1,
                showDetail: false,
                borderColor: "#e2e7f2",
                fillerColor: "rgba(89, 66, 214, 0.22)",
                handleSize: "90%",
              },
            ]
          : [],
        series: [
          {
            name: "Período selecionado",
            type: "bar",
            data: currentBars,
            barMaxWidth: 13,
          },
          {
            name: "Ano anterior",
            type: "bar",
            data: previousBars,
            barMaxWidth: 11,
          },
        ],
      };
    } else {
      const diffBars = rows.map((row, idx) => {
        const pair = row.values[metric];
        const diff =
          pair.current !== null && pair.previous !== null ? pair.current - pair.previous : null;
        const favorable = diff !== null && diff !== 0 && (diff > 0) === metrics[metric].up;
        const unfavorable = diff !== null && diff !== 0 && (diff > 0) !== metrics[metric].up;
        const selected = activeKey ? keys[idx] === activeKey : false;
        const color = favorable ? "#158057" : unfavorable ? "#c23a52" : "#64748b";
        return {
          value: diff,
          itemStyle: {
            color,
            opacity: activeKey && !selected ? 0.4 : 1,
            borderRadius: diff !== null && diff < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0],
          },
        };
      });

      option = {
        animation: !reducedMotion,
        animationDuration: 300,
        tooltip: baseTooltip,
        grid: {
          left: isCompact ? 98 : 154,
          right: hasRankZoom ? 26 : 14,
          top: 8,
          bottom: 24,
          containLabel: false,
        },
        xAxis: {
          type: "value",
          splitNumber: isCompact ? 3 : 4,
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: "#e5eaf3", type: "dashed" } },
          axisLabel: {
            color: "#627089",
            fontSize: 10,
            formatter: (val: number) => pretty(Number(val), metric, true),
          },
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: labels,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: "#33435a",
            fontSize: isCompact ? 10 : 11,
            width: isCompact ? 90 : 144,
            overflow: "truncate",
            formatter: (val: string) => truncateLabel(val, isCompact ? 14 : 23),
          },
        },
        dataZoom: hasRankZoom
          ? [
              {
                type: "inside",
                yAxisIndex: 0,
                startValue: 0,
                endValue: visibleLimit - 1,
                zoomOnMouseWheel: false,
                moveOnMouseWheel: true,
                moveOnMouseMove: true,
              },
              {
                type: "slider",
                yAxisIndex: 0,
                right: 2,
                width: 12,
                startValue: 0,
                endValue: visibleLimit - 1,
                showDetail: false,
                borderColor: "#e2e7f2",
                fillerColor: "rgba(89, 66, 214, 0.22)",
                handleSize: "90%",
              },
            ]
          : [],
        series: [
          {
            name: "Variação absoluta",
            type: "bar",
            data: diffBars,
            barMaxWidth: 16,
            markLine: {
              silent: true,
              symbol: "none",
              lineStyle: { color: "#94a3b8", type: "solid", width: 1 },
              label: { show: false },
              data: [{ xAxis: 0 }],
            },
          },
        ],
      };
    }

    chart.setOption(option, { notMerge: true });
    zoomCallbackRef.current?.(false);
  }, [r, metric, mode, isMonth, isCompact, hasMonthZoom, hasRankZoom, visibleLimit, activeKey, resetZoomNonce]);

  const heightStyle = isMonth
    ? undefined
    : {
        height: `${Math.min(360, Math.max(220, Math.min(r.rows.length, visibleLimit) * 35 + 42))}px`,
      };

  return (
    <div
      ref={hostRef}
      className="chart"
      style={heightStyle}
      role="img"
      aria-label={`Gráfico de ${metrics[metric].label}`}
    />
  );
}

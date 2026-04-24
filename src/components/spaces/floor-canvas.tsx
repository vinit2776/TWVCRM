"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { LocationFloor, SpaceUnit, SpaceUnitType } from "@/types";

const COLOR_MAP: Record<SpaceUnitType, string> = {
  hot_desk:      "#e0f2fe",
  dedicated_desk:"#bfdbfe",
  private_cabin: "#ede9fe",
  managed_office:"#fce7f3",
};

const BORDER_MAP: Record<SpaceUnitType, string> = {
  hot_desk:      "#7dd3fc",
  dedicated_desk:"#93c5fd",
  private_cabin: "#c4b5fd",
  managed_office:"#f9a8d4",
};

const LABEL_MAP: Record<SpaceUnitType, string> = {
  hot_desk:      "Hot Desk",
  dedicated_desk:"Dedicated",
  private_cabin: "Cabin",
  managed_office:"Office",
};

const CELL_SIZE = 44; // px

type DragState =
  | {
      type: "new-selection";
      startCol: number;
      startRow: number;
      endCol: number;
      endRow: number;
    }
  | {
      type: "move-unit";
      unit: SpaceUnit;
      offsetCol: number;
      offsetRow: number;
      currentCol: number;
      currentRow: number;
    };

interface Props {
  floor: LocationFloor;
  units: SpaceUnit[];
  mode: "view" | "edit";
  onCellSelect?: (selection: { gridCol: number; gridRow: number; gridColSpan: number; gridRowSpan: number }) => void;
  onUnitClick?: (unit: SpaceUnit) => void;
  onUnitMove?: (unit: SpaceUnit, newCol: number, newRow: number) => void;
}

function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

export function FloorCanvas({ floor, units, mode, onCellSelect, onUnitClick, onUnitMove }: Props) {
  const dragRef = useRef<DragState | null>(null);
  const svgRef = useRef<HTMLDivElement>(null);

  // Force re-render during drag to show ghost/preview
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick(t => t + 1), []);

  // Use a stable ref for rerender to use inside event listeners
  const rerenderRef = useRef(rerender);
  rerenderRef.current = rerender;

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const ds = dragRef.current;
    if (!ds) return;
    const container = svgRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const col = Math.max(1, Math.min(floor.grid_cols, Math.floor(relX / CELL_SIZE) + 1));
    const row = Math.max(1, Math.min(floor.grid_rows, Math.floor(relY / CELL_SIZE) + 1));

    if (ds.type === "new-selection") {
      dragRef.current = { ...ds, endCol: col, endRow: row };
    } else if (ds.type === "move-unit") {
      const newCol = Math.max(1, Math.min(floor.grid_cols - ds.unit.grid_col_span + 1, col - ds.offsetCol));
      const newRow = Math.max(1, Math.min(floor.grid_rows - ds.unit.grid_row_span + 1, row - ds.offsetRow));
      dragRef.current = { ...ds, currentCol: newCol, currentRow: newRow };
    }
    rerenderRef.current();
  }, [floor.grid_cols, floor.grid_rows]);

  const handleMouseUp = useCallback(() => {
    const ds = dragRef.current;
    if (!ds) return;
    dragRef.current = null;

    if (ds.type === "new-selection") {
      const colStart = Math.min(ds.startCol, ds.endCol);
      const rowStart = Math.min(ds.startRow, ds.endRow);
      const colSpan  = Math.abs(ds.endCol - ds.startCol) + 1;
      const rowSpan  = Math.abs(ds.endRow - ds.startRow) + 1;
      onCellSelect?.({ gridCol: colStart, gridRow: rowStart, gridColSpan: colSpan, gridRowSpan: rowSpan });
    } else if (ds.type === "move-unit") {
      const newCol = ds.currentCol;
      const newRow = ds.currentRow;
      // Collision check
      const hasCollision = units.some((u) => {
        if (u.id === ds.unit.id) return false;
        return rectsOverlap(
          newCol, newRow, ds.unit.grid_col_span, ds.unit.grid_row_span,
          u.grid_col, u.grid_row, u.grid_col_span, u.grid_row_span
        );
      });
      if (!hasCollision) {
        onUnitMove?.(ds.unit, newCol, newRow);
      }
    }
    rerenderRef.current();
  }, [units, onCellSelect, onUnitMove]);

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const currentDrag = dragRef.current;

  // Build ghost unit for move preview
  const ghostUnit = currentDrag?.type === "move-unit"
    ? { ...currentDrag.unit, grid_col: currentDrag.currentCol, grid_row: currentDrag.currentRow }
    : null;

  // Selection preview bounds
  let selPreview: { c1: number; r1: number; c2: number; r2: number } | null = null;
  if (currentDrag?.type === "new-selection") {
    selPreview = {
      c1: Math.min(currentDrag.startCol, currentDrag.endCol),
      r1: Math.min(currentDrag.startRow, currentDrag.endRow),
      c2: Math.max(currentDrag.startCol, currentDrag.endCol),
      r2: Math.max(currentDrag.startRow, currentDrag.endRow),
    };
  }

  return (
    <div
      ref={svgRef}
      className="relative border rounded-lg overflow-auto bg-white select-none"
      style={{
        width: `${floor.grid_cols * CELL_SIZE}px`,
        height: `${floor.grid_rows * CELL_SIZE}px`,
        minWidth: `${floor.grid_cols * CELL_SIZE}px`,
        display: "grid",
        gridTemplateColumns: `repeat(${floor.grid_cols}, ${CELL_SIZE}px)`,
        gridTemplateRows: `repeat(${floor.grid_rows}, ${CELL_SIZE}px)`,
      }}
    >
      {/* Cell grid overlay — only in edit mode */}
      {mode === "edit" && Array.from({ length: floor.grid_rows }).map((_, r) =>
        Array.from({ length: floor.grid_cols }).map((_, c) => {
          const col = c + 1;
          const row = r + 1;
          const isOccupied = units.some((u) =>
            u.id !== (currentDrag?.type === "move-unit" ? currentDrag.unit.id : null) &&
            col >= u.grid_col && col < u.grid_col + u.grid_col_span &&
            row >= u.grid_row && row < u.grid_row + u.grid_row_span
          );

          return (
            <div
              key={`cell-${col}-${row}`}
              style={{
                gridColumn: col,
                gridRow: row,
                zIndex: 1,
                cursor: isOccupied ? "default" : "crosshair",
              }}
              className="border border-gray-100 hover:bg-blue-50/30 transition-colors"
              onMouseDown={(e) => {
                if (isOccupied) return;
                e.preventDefault();
                dragRef.current = { type: "new-selection", startCol: col, startRow: row, endCol: col, endRow: row };
                rerenderRef.current();
              }}
            />
          );
        })
      )}

      {/* Existing space units */}
      {units.map((unit) => {
        const isBeingMoved = currentDrag?.type === "move-unit" && currentDrag.unit.id === unit.id;
        if (isBeingMoved) return null; // render ghost instead
        const bg = unit.color || COLOR_MAP[unit.type];
        const border = BORDER_MAP[unit.type];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const alloc = (unit as any).active_allocations?.[0];

        return (
          <div
            key={unit.id}
            style={{
              gridColumn: `${unit.grid_col} / span ${unit.grid_col_span}`,
              gridRow: `${unit.grid_row} / span ${unit.grid_row_span}`,
              zIndex: 2,
              backgroundColor: bg,
              border: `2px solid ${border}`,
              cursor: mode === "edit" ? "grab" : "pointer",
              userSelect: "none",
            }}
            className="rounded-sm p-1 overflow-hidden flex flex-col justify-between transition-shadow hover:shadow-md"
            onClick={() => onUnitClick?.(unit)}
            onMouseDown={(e) => {
              if (mode !== "edit") return;
              e.preventDefault();
              e.stopPropagation();
              const container = svgRef.current;
              if (!container) return;
              const rect = container.getBoundingClientRect();
              const relX = e.clientX - rect.left;
              const relY = e.clientY - rect.top;
              const clickCol = Math.floor(relX / CELL_SIZE) + 1;
              const clickRow = Math.floor(relY / CELL_SIZE) + 1;
              dragRef.current = {
                type: "move-unit",
                unit,
                offsetCol: clickCol - unit.grid_col,
                offsetRow: clickRow - unit.grid_row,
                currentCol: unit.grid_col,
                currentRow: unit.grid_row,
              };
              rerenderRef.current();
            }}
          >
            <div>
              <p className="font-mono text-[10px] font-bold leading-tight text-gray-700 truncate">{unit.code}</p>
              <p className="text-[9px] leading-tight text-gray-600 truncate">{unit.name}</p>
            </div>
            <div className="flex items-end justify-between gap-1">
              <span className="text-[8px] text-gray-500 leading-tight">{LABEL_MAP[unit.type]}</span>
              <div className="flex flex-col items-end gap-0.5">
                <Badge
                  variant="secondary"
                  className="text-[8px] px-1 py-0 h-3 leading-none"
                  style={{ backgroundColor: border, color: "white", border: "none" }}
                >
                  {unit.capacity}p
                </Badge>
                {alloc && (
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 ml-auto" title="Contracted" />
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Ghost unit while dragging */}
      {ghostUnit && (
        <div
          style={{
            gridColumn: `${ghostUnit.grid_col} / span ${ghostUnit.grid_col_span}`,
            gridRow: `${ghostUnit.grid_row} / span ${ghostUnit.grid_row_span}`,
            zIndex: 5,
            backgroundColor: ghostUnit.color || COLOR_MAP[ghostUnit.type],
            border: `2px dashed ${BORDER_MAP[ghostUnit.type]}`,
            opacity: 0.7,
            pointerEvents: "none",
          }}
          className="rounded-sm"
        />
      )}

      {/* Selection preview rectangle */}
      {selPreview && (
        <div
          style={{
            gridColumn: `${selPreview.c1} / span ${selPreview.c2 - selPreview.c1 + 1}`,
            gridRow: `${selPreview.r1} / span ${selPreview.r2 - selPreview.r1 + 1}`,
            zIndex: 3,
            backgroundColor: "rgba(59,130,246,0.15)",
            border: "2px dashed #3b82f6",
            borderRadius: "4px",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

export function CanvasLegend() {
  const types: SpaceUnitType[] = ["hot_desk", "dedicated_desk", "private_cabin", "managed_office"];
  return (
    <div className="flex flex-wrap gap-3 mt-2">
      {types.map((t) => (
        <div key={t} className="flex items-center gap-1.5">
          <div
            className="w-4 h-4 rounded border"
            style={{ backgroundColor: COLOR_MAP[t], borderColor: BORDER_MAP[t] }}
          />
          <span className="text-xs text-muted-foreground">{LABEL_MAP[t]}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <div className="w-4 h-4 rounded-full bg-green-500" />
        <span className="text-xs text-muted-foreground">Contracted</span>
      </div>
    </div>
  );
}

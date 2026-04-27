"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { MapPin } from "lucide-react";
import type { LocationFloor, SpaceUnit, SpaceUnitType } from "@/types";
import type { PendingSpaceUnit } from "./space-unit-form-dialog";

// ── Visual constants ────────────────────────────────────────────────────────

export const COLOR_MAP: Record<SpaceUnitType, string> = {
  hot_desk:        "#e0f2fe",
  dedicated_desk:  "#bfdbfe",
  private_cabin:   "#ede9fe",
  managed_office:  "#fce7f3",
  business_centre: "#fef3c7",
};

const BORDER_MAP: Record<SpaceUnitType, string> = {
  hot_desk:        "#7dd3fc",
  dedicated_desk:  "#93c5fd",
  private_cabin:   "#c4b5fd",
  managed_office:  "#f9a8d4",
  business_centre: "#fcd34d",
};

const LABEL_MAP: Record<SpaceUnitType, string> = {
  hot_desk:        "Hot Desk",
  dedicated_desk:  "Dedicated",
  private_cabin:   "Cabin",
  managed_office:  "Office",
  business_centre: "Bus. Centre",
};

const CELL_SIZE = 44; // px per grid cell

// ── Helpers ─────────────────────────────────────────────────────────────────

function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

// ── Types ────────────────────────────────────────────────────────────────────

type MoveState = {
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
  /** When set, the canvas enters placement mode: ghost block follows cursor, click places */
  pendingUnit?: PendingSpaceUnit | null;
  onPlaceUnit?: (col: number, row: number) => void;
  onCancelPlacement?: () => void;
  onUnitClick?: (unit: SpaceUnit) => void;
  onUnitMove?: (unit: SpaceUnit, newCol: number, newRow: number) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function FloorCanvas({
  floor, units, mode,
  pendingUnit, onPlaceUnit, onCancelPlacement,
  onUnitClick, onUnitMove,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Ghost cursor position for placement mode
  const [ghostPos, setGhostPos] = useState<{ col: number; row: number } | null>(null);

  // Move-existing-unit drag state
  const [moveState, setMoveState] = useState<MoveState | null>(null);
  const moveRef = useRef<MoveState | null>(null);
  const unitsRef = useRef(units);
  const onUnitMoveRef = useRef(onUnitMove);
  useEffect(() => { moveRef.current = moveState; }, [moveState]);
  useEffect(() => { unitsRef.current = units; }, [units]);
  useEffect(() => { onUnitMoveRef.current = onUnitMove; }, [onUnitMove]);

  // ESC key cancels placement
  useEffect(() => {
    if (!pendingUnit) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelPlacement?.();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pendingUnit, onCancelPlacement]);

  // Clear ghost when leaving placement mode
  useEffect(() => {
    if (!pendingUnit) setGhostPos(null);
  }, [pendingUnit]);

  // Shared: get grid col/row from mouse event relative to container
  const getCellFromMouse = useCallback((e: MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const col = clamp(Math.floor((e.clientX - rect.left)  / CELL_SIZE) + 1, 1, floor.grid_cols);
    const row = clamp(Math.floor((e.clientY - rect.top)   / CELL_SIZE) + 1, 1, floor.grid_rows);
    return { col, row };
  }, [floor.grid_cols, floor.grid_rows]);

  // ── Global mouse handlers ───────────────────────────────────────────────

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const cell = getCellFromMouse(e);
      if (!cell) return;

      // Placement mode: update ghost position
      if (pendingUnit) {
        const col = clamp(cell.col, 1, floor.grid_cols - pendingUnit.grid_col_span + 1);
        const row = clamp(cell.row, 1, floor.grid_rows - pendingUnit.grid_row_span + 1);
        setGhostPos({ col, row });
        return;
      }

      // Move-unit mode: update drag position
      const ms = moveRef.current;
      if (!ms) return;
      const newCol = clamp(cell.col - ms.offsetCol, 1, floor.grid_cols - ms.unit.grid_col_span + 1);
      const newRow = clamp(cell.row - ms.offsetRow, 1, floor.grid_rows - ms.unit.grid_row_span + 1);
      setMoveState({ ...ms, currentCol: newCol, currentRow: newRow });
    };

    const handleUp = () => {
      const ms = moveRef.current;
      if (!ms) return;
      setMoveState(null);
      const hasCollision = unitsRef.current.some((u) => {
        if (u.id === ms.unit.id) return false;
        return rectsOverlap(
          ms.currentCol, ms.currentRow, ms.unit.grid_col_span, ms.unit.grid_row_span,
          u.grid_col, u.grid_row, u.grid_col_span, u.grid_row_span
        );
      });
      if (!hasCollision) {
        onUnitMoveRef.current?.(ms.unit, ms.currentCol, ms.currentRow);
      }
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [pendingUnit, getCellFromMouse, floor.grid_cols, floor.grid_rows]);

  // ── Placement click ─────────────────────────────────────────────────────

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pendingUnit || !ghostPos) return;
    e.preventDefault();

    // Collision check
    const hasCollision = units.some((u) =>
      rectsOverlap(
        ghostPos.col, ghostPos.row, pendingUnit.grid_col_span, pendingUnit.grid_row_span,
        u.grid_col, u.grid_row, u.grid_col_span, u.grid_row_span
      )
    );
    if (hasCollision) return; // Optionally: show a toast or shake animation

    onPlaceUnit?.(ghostPos.col, ghostPos.row);
  };

  // ── Render ──────────────────────────────────────────────────────────────

  const inPlacementMode = !!pendingUnit;

  // Ghost for pending placement
  const placementGhost = inPlacementMode && ghostPos ? {
    col: ghostPos.col,
    row: ghostPos.row,
    colSpan: pendingUnit.grid_col_span,
    rowSpan: pendingUnit.grid_row_span,
    type: pendingUnit.type,
    name: pendingUnit.name,
    code: pendingUnit.code,
    color: pendingUnit.color || COLOR_MAP[pendingUnit.type],
  } : null;

  // Ghost for move-drag
  const moveGhost = moveState
    ? { ...moveState.unit, grid_col: moveState.currentCol, grid_row: moveState.currentRow }
    : null;

  // Check if placement position has a collision (to show red ghost)
  const placementCollides = placementGhost
    ? units.some((u) =>
        rectsOverlap(
          placementGhost.col, placementGhost.row, placementGhost.colSpan, placementGhost.rowSpan,
          u.grid_col, u.grid_row, u.grid_col_span, u.grid_row_span
        )
      )
    : false;

  return (
    <div className="space-y-2">
      {/* Placement mode banner */}
      {inPlacementMode && (
        <div className="flex items-center justify-between rounded-lg border border-[#015E65]/30 bg-[#015E65]/5 px-4 py-2.5">
          <div className="flex items-center gap-2.5 text-sm text-[#015E65]">
            <MapPin className="h-4 w-4 shrink-0" />
            <span>
              <span className="font-semibold">Click on the canvas</span> to place{" "}
              <span className="font-mono font-bold">{pendingUnit.code}</span> — {pendingUnit.name}
              {placementCollides && (
                <span className="ml-2 text-red-600 font-medium">← overlaps an existing unit</span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancelPlacement}
            className="text-xs text-muted-foreground hover:text-foreground underline ml-4"
          >
            Cancel (ESC)
          </button>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={containerRef}
        onClick={handleCanvasClick}
        className="relative border rounded-lg overflow-auto bg-white select-none"
        style={{
          width: `${floor.grid_cols * CELL_SIZE}px`,
          height: `${floor.grid_rows * CELL_SIZE}px`,
          minWidth: `${floor.grid_cols * CELL_SIZE}px`,
          display: "grid",
          gridTemplateColumns: `repeat(${floor.grid_cols}, ${CELL_SIZE}px)`,
          gridTemplateRows: `repeat(${floor.grid_rows}, ${CELL_SIZE}px)`,
          cursor: inPlacementMode
            ? (placementCollides ? "not-allowed" : "crosshair")
            : "default",
        }}
        onMouseMove={(e) => {
          // Synthetic React event for placement ghost when mouse stays inside canvas
          // (Global handler covers most movement, this handles the edge boundary)
          if (!inPlacementMode) return;
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const col = clamp(Math.floor((e.clientX - rect.left)  / CELL_SIZE) + 1, 1, floor.grid_cols  - (pendingUnit?.grid_col_span ?? 1) + 1);
          const row = clamp(Math.floor((e.clientY - rect.top)   / CELL_SIZE) + 1, 1, floor.grid_rows  - (pendingUnit?.grid_row_span ?? 1) + 1);
          setGhostPos({ col, row });
        }}
        onMouseLeave={() => {
          if (inPlacementMode) setGhostPos(null);
        }}
      >
        {/* Grid cell overlay — always visible in edit/placement mode */}
        {(mode === "edit" || inPlacementMode) &&
          Array.from({ length: floor.grid_rows }).map((_, r) =>
            Array.from({ length: floor.grid_cols }).map((_, c) => (
              <div
                key={`cell-${c}-${r}`}
                style={{ gridColumn: c + 1, gridRow: r + 1, zIndex: 1 }}
                className="border border-gray-100"
              />
            ))
          )
        }

        {/* Existing space units */}
        {units.map((unit) => {
          if (moveState?.unit.id === unit.id) return null;
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
                cursor: inPlacementMode ? "not-allowed" : mode === "edit" ? "grab" : "pointer",
                opacity: inPlacementMode ? 0.55 : 1,
                userSelect: "none",
              }}
              className="rounded-sm p-1 overflow-hidden flex flex-col justify-between transition-shadow hover:shadow-md"
              onClick={(e) => {
                if (inPlacementMode) { e.stopPropagation(); return; }
                onUnitClick?.(unit);
              }}
              onMouseDown={(e) => {
                if (inPlacementMode || mode !== "edit") return;
                e.preventDefault();
                e.stopPropagation();
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                const clickCol = Math.floor((e.clientX - rect.left) / CELL_SIZE) + 1;
                const clickRow = Math.floor((e.clientY - rect.top)  / CELL_SIZE) + 1;
                setMoveState({
                  unit,
                  offsetCol: clickCol - unit.grid_col,
                  offsetRow: clickRow - unit.grid_row,
                  currentCol: unit.grid_col,
                  currentRow: unit.grid_row,
                });
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
                  {alloc && <div className="w-1.5 h-1.5 rounded-full bg-green-500" title="Contracted" />}
                </div>
              </div>
            </div>
          );
        })}

        {/* Ghost: move-drag preview */}
        {moveGhost && (
          <div
            style={{
              gridColumn: `${moveGhost.grid_col} / span ${moveGhost.grid_col_span}`,
              gridRow: `${moveGhost.grid_row} / span ${moveGhost.grid_row_span}`,
              zIndex: 5,
              backgroundColor: moveGhost.color || COLOR_MAP[moveGhost.type],
              border: `2px dashed ${BORDER_MAP[moveGhost.type]}`,
              opacity: 0.7,
              pointerEvents: "none",
              borderRadius: "4px",
            }}
          />
        )}

        {/* Ghost: placement preview */}
        {placementGhost && (
          <div
            style={{
              gridColumn: `${placementGhost.col} / span ${placementGhost.colSpan}`,
              gridRow: `${placementGhost.row} / span ${placementGhost.rowSpan}`,
              zIndex: 6,
              backgroundColor: placementCollides
                ? "rgba(239,68,68,0.15)"
                : placementGhost.color,
              border: `2px dashed ${placementCollides ? "#ef4444" : BORDER_MAP[placementGhost.type]}`,
              opacity: 0.85,
              pointerEvents: "none",
              borderRadius: "4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div className="text-center px-1">
              <p className="font-mono text-[10px] font-bold text-gray-700 truncate">{placementGhost.code}</p>
              <p className="text-[8px] text-gray-500 truncate">{placementGhost.name}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Legend ───────────────────────────────────────────────────────────────────

export function CanvasLegend() {
  const types: SpaceUnitType[] = ["hot_desk", "dedicated_desk", "private_cabin", "managed_office", "business_centre"];
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

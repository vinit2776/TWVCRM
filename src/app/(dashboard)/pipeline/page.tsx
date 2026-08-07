"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLeads } from "@/hooks/use-leads";
import { RatingBadge } from "@/components/shared/status-badge";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_COLORS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Lead } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

function LeadCard({
  lead,
  isDragging,
}: {
  lead: Lead;
  isDragging?: boolean;
}) {
  const router = useRouter();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: lead.id, data: { lead } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "rounded-lg border bg-background p-3 shadow-sm cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow",
        (isSortableDragging || isDragging) && "opacity-50"
      )}
      onClick={() => router.push(`/leads/${lead.id}`)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm truncate">
            {lead.first_name} {lead.last_name}
          </p>
          {lead.company && (
            <p className="text-xs text-muted-foreground truncate">
              {lead.company}
            </p>
          )}
        </div>
        <RatingBadge rating={lead.rating} />
      </div>
      {(lead.email || lead.phone) && (
        <p className="text-xs text-muted-foreground mt-1 truncate">
          {lead.email || lead.phone}
        </p>
      )}
      {lead.workspace_type && (
        <p className="text-xs text-muted-foreground mt-1">
          {lead.seat_capacity && `${lead.seat_capacity} seats`}
        </p>
      )}
    </div>
  );
}

function PipelineColumn({
  status,
  leads,
}: {
  status: string;
  leads: Lead[];
}) {
  return (
    <div className="flex-shrink-0 w-72 flex flex-col">
      <div
        className={cn(
          "rounded-t-lg px-3 py-2 flex items-center justify-between",
          LEAD_STATUS_COLORS[status]
        )}
      >
        <span className="font-medium text-sm">
          {LEAD_STATUS_LABELS[status]}
        </span>
        <span className="text-xs font-medium">{leads.length}</span>
      </div>
      <div className="flex-1 bg-muted/30 rounded-b-lg p-2 space-y-2 min-h-[200px] overflow-y-auto max-h-[calc(100vh-16rem)]">
        <SortableContext
          items={leads.map((l) => l.id)}
          strategy={verticalListSortingStrategy}
        >
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} />
          ))}
        </SortableContext>
        {leads.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            No leads
          </p>
        )}
      </div>
    </div>
  );
}

export default function PipelinePage() {
  const { data: leads, loading, refetch } = useLeads({ limit: 200 });
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const leadsByStatus: Record<string, Lead[]> = {};
  for (const s of LEAD_STATUSES) {
    leadsByStatus[s] = [];
  }
  for (const lead of leads) {
    if (leadsByStatus[lead.status]) {
      leadsByStatus[lead.status].push(lead);
    }
  }

  const activeLead = activeId
    ? leads.find((l) => l.id === activeId)
    : null;

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over) return;

      const draggedLead = leads.find((l) => l.id === active.id);
      if (!draggedLead) return;

      // Find which column the card was dropped in
      let targetStatus: string | null = null;

      // Check if dropped over another lead card
      const overLead = leads.find((l) => l.id === over.id);
      if (overLead) {
        targetStatus = overLead.status;
      }

      if (!targetStatus || targetStatus === draggedLead.status) return;

      // Update the lead status
      const res = await fetch(`/api/leads/${draggedLead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: targetStatus }),
      });

      if (res.ok) {
        toast.success(`Lead moved to ${LEAD_STATUS_LABELS[targetStatus]}`);
      }
      refetch();
    },
    [leads, refetch]
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <TableSkeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Pipeline" }} />
      <div>
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Drag leads between columns to change their status
        </p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {LEAD_STATUSES.map((status) => (
            <PipelineColumn
              key={status}
              status={status}
              leads={leadsByStatus[status]}
            />
          ))}
        </div>

        <DragOverlay>
          {activeLead && <LeadCard lead={activeLead} isDragging />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

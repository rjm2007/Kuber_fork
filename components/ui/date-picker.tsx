"use client";

import * as React from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Shared date field — the only way to pick a single date anywhere in the app.
 * Wraps the existing Calendar in a field-styled trigger so it matches
 * Input/Select on the same bg-field surface (see globals.css surface ladder).
 */
export function DatePicker({
  date,
  onChangeDate,
  placeholder = "Pick a date",
  displayFormat = "PPP",
  className,
  disabled,
  size = "default",
  showQuickActions = false,
}: {
  date: Date | undefined;
  onChangeDate: (date: Date | undefined) => void;
  placeholder?: string;
  /** date-fns format string for the trigger label. */
  displayFormat?: string;
  className?: string;
  disabled?: boolean;
  size?: "default" | "sm";
  /** Adds a Today / Clear footer row under the calendar. */
  showQuickActions?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-start gap-2 bg-field font-normal text-left hover:bg-field",
            size === "sm" ? "h-8 px-3 text-xs" : "px-3 py-2 text-sm",
            !date && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className={cn("shrink-0", size === "sm" ? "size-3.5" : "size-4")} />
          {date ? format(date, displayFormat) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            onChangeDate(d);
            setOpen(false);
          }}
        />
        {showQuickActions && (
          <div className="flex items-center justify-between border-t border-border bg-secondary/30 px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => { onChangeDate(undefined); setOpen(false); }}
            >
              Clear
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => { onChangeDate(new Date()); setOpen(false); }}
            >
              Today
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

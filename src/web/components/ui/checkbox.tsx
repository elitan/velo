import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '#lib/utils';

export interface CheckboxProps extends Omit<React.ComponentProps<'input'>, 'type'> {}

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <span className="relative inline-grid size-4 shrink-0 place-items-center">
      <input
        type="checkbox"
        className={cn(
          'peer size-4 appearance-none rounded border border-input bg-background transition-colors checked:border-primary checked:bg-primary focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
          className
        )}
        {...props}
      />
      <Check className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100" />
    </span>
  );
}

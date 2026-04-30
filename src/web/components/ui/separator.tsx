import * as React from 'react';
import { cn } from '@/lib/utils';

export function Separator({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="separator"
      className={cn('bg-border h-px w-full shrink-0', className)}
      {...props}
    />
  );
}

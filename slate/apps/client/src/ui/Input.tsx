import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../utils/cn';

const base =
  'w-full rounded-sm border border-border-2 bg-bg-3 px-3 py-2 font-mono text-sm text-text placeholder:text-text-dim outline-none transition-[border-color,box-shadow] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => <input ref={ref} className={cn(base, className)} {...rest} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={cn(base, 'resize-y leading-relaxed', className)} {...rest} />
));
Textarea.displayName = 'Textarea';

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="panel-title mb-1.5">{children}</div>;
}

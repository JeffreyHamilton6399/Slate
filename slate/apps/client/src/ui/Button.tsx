import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../utils/cn';

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-sm font-semibold transition-[opacity,transform,background-color,border-color,color] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/90',
        ghost: 'bg-transparent border border-border-2 text-text-mid hover:border-accent hover:text-accent',
        outline: 'bg-bg-3 border border-border-2 text-text hover:bg-bg-4',
        danger: 'bg-danger text-white hover:bg-danger/90',
        subtle: 'bg-bg-3 text-text hover:bg-bg-4',
        icon: 'p-1.5 bg-transparent border border-transparent text-text-mid hover:bg-bg-4 hover:border-border hover:text-text rounded-sm',
      },
      size: {
        sm: 'text-xs px-2.5 py-1.5',
        md: 'text-sm px-4 py-2',
        lg: 'text-base px-5 py-2.5',
        none: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...rest} />
  ),
);
Button.displayName = 'Button';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface ConditionalTooltipProps {
  content: string
  showTooltip: boolean
  children: React.ReactNode
  side: 'top' | 'right' | 'bottom' | 'left'
  className?: string
}

export const ConditionalTooltip = ({
  content,
  side,
  showTooltip,
  children,
  className,
}: ConditionalTooltipProps) => {
  if (showTooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          className={`bg-stone-800 text-white p-2.5 text-sm ${className}`}
        >
          {content}
        </TooltipContent>
      </Tooltip>
    )
  }
  return <>{children}</>
}

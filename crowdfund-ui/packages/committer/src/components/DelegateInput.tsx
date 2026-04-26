// ABOUTME: Delegate address selector for ARM claim with mandatory delegation.
// ABOUTME: Pre-filled with connected address (self-delegate), supports custom address input.

import { useState, useEffect } from 'react'
import { isAddress } from 'ethers'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  InfoTooltip,
  Input,
  TOOLTIPS,
  ToggleGroup,
  ToggleGroupItem,
} from '@armada/crowdfund-shared'

export interface DelegateInputProps {
  connectedAddress: string
  value: string
  onChange: (address: string) => void
}

interface DelegateFormValues {
  customAddress: string
}

const delegateSchema = z
  .object({
    customAddress: z.string(),
  })
  .superRefine((values, ctx) => {
    const raw = values.customAddress.trim()
    if (!raw) return // empty is fine — submit button disabled via isAddress check
    if (!isAddress(raw)) {
      ctx.addIssue({
        code: 'custom',
        path: ['customAddress'],
        message: 'Invalid address',
      })
    }
  })

export function DelegateInput({ connectedAddress, value, onChange }: DelegateInputProps) {
  const [useSelf, setUseSelf] = useState(true)

  const form = useForm<DelegateFormValues>({
    // @hookform/resolvers v5 + zod v4: generic inference loses the schema binding;
    // runtime is correct but TS needs a cast.
    resolver: zodResolver(delegateSchema) as unknown as Resolver<DelegateFormValues>,
    mode: 'onChange',
    defaultValues: { customAddress: '' },
  })

  useEffect(() => {
    if (useSelf) {
      onChange(connectedAddress)
    } else {
      onChange(form.getValues('customAddress'))
    }
  }, [useSelf, connectedAddress, onChange, form])

  // Keep the rendered value in sync when parent resets the delegate externally.
  useEffect(() => {
    if (!useSelf && value !== form.getValues('customAddress')) {
      form.setValue('customAddress', value, { shouldValidate: true })
    }
  }, [useSelf, value, form])

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-background/25 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>Delegate Address</span>
        <InfoTooltip text={TOOLTIPS.delegate} label="What is a delegate?" />
      </div>
      <ToggleGroup
        type="single"
        value={useSelf ? 'self' : 'custom'}
        onValueChange={(v) => {
          if (v === 'self') setUseSelf(true)
          else if (v === 'custom') setUseSelf(false)
        }}
        className="gap-2"
      >
        <ToggleGroupItem value="self" size="sm" className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          Self
        </ToggleGroupItem>
        <ToggleGroupItem value="custom" size="sm" className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          Custom
        </ToggleGroupItem>
      </ToggleGroup>
      {!useSelf && (
        <Form {...form}>
          <FormField
            control={form.control}
            name="customAddress"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormControl>
                  <Input
                    {...field}
                    type="text"
                    placeholder="0x..."
                    className="h-11 rounded-md border-border/70 bg-background/35 text-sm font-mono shadow-inner focus-visible:border-primary/70 focus-visible:ring-primary/20"
                    aria-invalid={!!fieldState.error || undefined}
                    onChange={(e) => {
                      field.onChange(e)
                      onChange(e.target.value)
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </Form>
      )}
    </div>
  )
}

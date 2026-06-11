/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useStatus } from '@/hooks/use-status'
import { useSystemConfig } from '@/hooks/use-system-config'
import { DEFAULT_DISCOUNT_RATE } from '../constants'
import {
  usePayment,
  useRedemption,
  useCreemPayment,
  useWaffoPayment,
  useWaffoPancakePayment,
} from '../hooks'
import {
  getDefaultPaymentType,
  getMinTopupAmount,
  isWaffoPancakePayment,
} from '../lib'
import type {
  PaymentMethod,
  PresetAmount,
  CreemProduct,
  TopupInfo,
} from '../types'
import { CreemConfirmDialog } from './dialogs/creem-confirm-dialog'
import { PaymentConfirmDialog } from './dialogs/payment-confirm-dialog'
import { RechargeFormCard } from './recharge-form-card'

interface RechargePanelProps {
  topupInfo: TopupInfo | null
  presetAmounts: PresetAmount[]
  topupLoading?: boolean
  onOpenBilling?: () => void
  onRechargeSuccess?: () => Promise<void> | void
}

export function RechargePanel({
  topupInfo,
  presetAmounts,
  topupLoading,
  onOpenBilling,
  onRechargeSuccess,
}: RechargePanelProps) {
  const [topupAmount, setTopupAmount] = useState(0)
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod>()
  const [paymentLoading, setPaymentLoading] = useState<string | null>(null)
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [redemptionCode, setRedemptionCode] = useState('')
  const [creemDialogOpen, setCreemDialogOpen] = useState(false)
  const [selectedCreemProduct, setSelectedCreemProduct] =
    useState<CreemProduct | null>(null)

  const { status } = useStatus()
  const { currency } = useSystemConfig()
  const {
    amount: paymentAmount,
    calculating,
    processing,
    calculatePaymentAmount,
    processPayment,
  } = usePayment()
  const { redeeming, redeemCode } = useRedemption()
  const { processing: creemProcessing, processCreemPayment } = useCreemPayment()
  const { processWaffoPayment } = useWaffoPayment()
  const { processing: pancakeProcessing, processWaffoPancakePayment } =
    useWaffoPancakePayment()

  const effectiveUsdExchangeRate = useMemo(() => {
    return currency?.quotaDisplayType === 'USD'
      ? 1
      : currency?.usdExchangeRate || 1
  }, [currency?.quotaDisplayType, currency?.usdExchangeRate])

  useEffect(() => {
    if (topupInfo && topupAmount === 0) {
      const minTopup = getMinTopupAmount(topupInfo)
      setTopupAmount(minTopup)
      calculatePaymentAmount(minTopup, getDefaultPaymentType(topupInfo))
    }
  }, [topupInfo, topupAmount, calculatePaymentAmount])

  const getCurrentPaymentType = useCallback(() => {
    return selectedPaymentMethod?.type || getDefaultPaymentType(topupInfo)
  }, [selectedPaymentMethod, topupInfo])

  const handleSuccess = useCallback(async () => {
    await onRechargeSuccess?.()
  }, [onRechargeSuccess])

  const handleSelectPreset = (preset: PresetAmount) => {
    setTopupAmount(preset.value)
    setSelectedPreset(preset.value)
    calculatePaymentAmount(preset.value, getCurrentPaymentType())
  }

  const handleTopupAmountChange = (amount: number) => {
    setTopupAmount(amount)
    setSelectedPreset(null)
    calculatePaymentAmount(amount, getCurrentPaymentType())
  }

  const handlePaymentMethodSelect = async (method: PaymentMethod) => {
    setSelectedPaymentMethod(method)
    setPaymentLoading(method.type)

    try {
      const minTopup = getMinTopupAmount(topupInfo)
      if (topupAmount < minTopup) {
        return
      }

      await calculatePaymentAmount(topupAmount, method.type)
      setConfirmDialogOpen(true)
    } finally {
      setPaymentLoading(null)
    }
  }

  const handlePaymentConfirm = async () => {
    if (!selectedPaymentMethod) return

    const isPancake = isWaffoPancakePayment(selectedPaymentMethod.type)
    const success = isPancake
      ? await processWaffoPancakePayment(topupAmount)
      : await processPayment(topupAmount, selectedPaymentMethod.type)

    if (success) {
      setConfirmDialogOpen(false)
      await handleSuccess()
    }
  }

  const handleRedeem = async () => {
    if (!redemptionCode) return

    const success = await redeemCode(redemptionCode)
    if (success) {
      setRedemptionCode('')
      await handleSuccess()
    }
  }

  const handleCreemProductSelect = (product: CreemProduct) => {
    setSelectedCreemProduct(product)
    setCreemDialogOpen(true)
  }

  const handleCreemConfirm = async () => {
    if (!selectedCreemProduct) return

    const success = await processCreemPayment(selectedCreemProduct.productId)
    if (success) {
      setCreemDialogOpen(false)
      setSelectedCreemProduct(null)
      await handleSuccess()
    }
  }

  const handleWaffoMethodSelect = async (_method: unknown, index: number) => {
    const loadingKey = `waffo-${index}`
    setPaymentLoading(loadingKey)

    try {
      const success = await processWaffoPayment(topupAmount, index)
      if (success) {
        await handleSuccess()
      }
    } finally {
      setPaymentLoading(null)
    }
  }

  const getDiscountRate = useCallback(() => {
    return topupInfo?.discount?.[topupAmount] || DEFAULT_DISCOUNT_RATE
  }, [topupInfo, topupAmount])

  return (
    <>
      <RechargeFormCard
        topupInfo={topupInfo}
        presetAmounts={presetAmounts}
        selectedPreset={selectedPreset}
        onSelectPreset={handleSelectPreset}
        topupAmount={topupAmount}
        onTopupAmountChange={handleTopupAmountChange}
        paymentAmount={paymentAmount}
        calculating={calculating}
        onPaymentMethodSelect={handlePaymentMethodSelect}
        paymentLoading={paymentLoading}
        redemptionCode={redemptionCode}
        onRedemptionCodeChange={setRedemptionCode}
        onRedeem={handleRedeem}
        redeeming={redeeming}
        topupLink={topupInfo?.topup_link}
        loading={topupLoading}
        priceRatio={(status?.price as number) || 1}
        usdExchangeRate={effectiveUsdExchangeRate}
        onOpenBilling={onOpenBilling}
        creemProducts={topupInfo?.creem_products}
        enableCreemTopup={topupInfo?.enable_creem_topup}
        onCreemProductSelect={handleCreemProductSelect}
        enableWaffoTopup={topupInfo?.enable_waffo_topup}
        waffoPayMethods={topupInfo?.waffo_pay_methods}
        waffoMinTopup={topupInfo?.waffo_min_topup}
        onWaffoMethodSelect={handleWaffoMethodSelect}
        enableWaffoPancakeTopup={topupInfo?.enable_waffo_pancake_topup}
      />

      <PaymentConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        onConfirm={handlePaymentConfirm}
        topupAmount={topupAmount}
        paymentAmount={paymentAmount}
        paymentMethod={selectedPaymentMethod}
        calculating={calculating}
        processing={processing || pancakeProcessing}
        discountRate={getDiscountRate()}
        usdExchangeRate={effectiveUsdExchangeRate}
      />

      <CreemConfirmDialog
        open={creemDialogOpen}
        onOpenChange={setCreemDialogOpen}
        onConfirm={handleCreemConfirm}
        product={selectedCreemProduct}
        processing={creemProcessing}
      />
    </>
  )
}

<script setup lang="ts">
import type { MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { nth } from 'es-toolkit/compat'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { LLMMessage } from '@/services/gemini'

import heartbeat from '@/assets/pet/heartbeat.json'
import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { useGamepad } from '@/composables/useGamepad'
import { useModel } from '@/composables/useModel'
import { useTauriListen } from '@/composables/useTauriListen'
import { CHAT_INPUT_SPACE_RATIO, DIALOGUE_BUBBLE_SPACE_RATIO, LISTEN_KEY } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { generatePetHeartbeat, generatePetReply } from '@/services/gemini'
import { consumePetActivitySummary } from '@/services/petActivity'
import { applyPetMemoryUpdates } from '@/services/petMemory'
import { applyPetTaskUpdates } from '@/services/petTasks'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import { isImage } from '@/utils/is'
import live2d from '@/utils/live2d'
import { join } from '@/utils/path'
import { isWindows } from '@/utils/platform'
import { clearObject } from '@/utils/shared'

const { startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const { modelSize, handleLoad, handleDestroy, handleResize, handleKeyChange } = useModel()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const resizing = ref(false)
const backgroundImagePath = ref<string>()
const { stickActive } = useGamepad()
const dialogueText = ref('')
const dialogueVisible = ref(false)
const chatInput = ref('')
const chatLoading = ref(false)
const chatHistory = ref<LLMMessage[]>([])
const contentSpaceRatio = 1 + DIALOGUE_BUBBLE_SPACE_RATIO + CHAT_INPUT_SPACE_RATIO
const modelLayerHeight = `${100 / contentSpaceRatio}%`
const chatLayerHeight = `${(CHAT_INPUT_SPACE_RATIO / contentSpaceRatio) * 100}%`
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
let dialogueHideTimer: ReturnType<typeof setTimeout> | undefined
let dialogueShowFrame: number | undefined

onMounted(startListening)

onMounted(scheduleNextHeartbeat)

onUnmounted(() => {
  handleDestroy()
  clearDialogueTimers()
})

const debouncedResize = useDebounceFn(async () => {
  await handleResize()

  resizing.value = false
}, 100)

useEventListener('resize', () => {
  resizing.value = true

  debouncedResize()
})

watch(() => modelStore.currentModel, async (model) => {
  if (!model) return

  await handleLoad()

  const path = join(model.path, 'resources', 'background.png')

  const existed = await exists(path)

  backgroundImagePath.value = existed ? convertFileSrc(path) : void 0

  clearObject([modelStore.supportKeys, modelStore.pressedKeys])

  const resourcePath = join(model.path, 'resources')
  const groups = ['left-keys', 'right-keys']

  for await (const groupName of groups) {
    const groupDir = join(resourcePath, groupName)
    const files = await readDir(groupDir).catch(() => [])
    const imageFiles = files.filter(file => isImage(file.name))

    for (const file of imageFiles) {
      const fileName = file.name.split('.')[0]

      modelStore.supportKeys[fileName] = join(groupDir, file.name)
    }
  }

  modelStore.modelReady = true
}, { deep: true, immediate: true })

watch([() => catStore.window.scale, modelSize], async ([scale, modelSize]) => {
  if (!modelSize) return

  const { width, height } = modelSize
  const extraSpace = height * (DIALOGUE_BUBBLE_SPACE_RATIO + CHAT_INPUT_SPACE_RATIO)

  appWindow.setSize(
    new PhysicalSize({
      width: Math.round(width * (scale / 100)),
      height: Math.round((height + extraSpace) * (scale / 100)),
    }),
  )
}, { immediate: true })

watch([modelStore.pressedKeys, stickActive], ([keys, stickActive]) => {
  const dirs = Object.values(keys).map((path) => {
    return nth(path.split(sep()), -2)!
  })

  const hasLeft = dirs.some(dir => dir.startsWith('left'))
  const hasRight = dirs.some(dir => dir.startsWith('right'))

  handleKeyChange(true, stickActive.left || hasLeft)
  handleKeyChange(false, stickActive.right || hasRight)
}, { deep: true })

watch(() => catStore.window.visible, async (value) => {
  value ? showWindow() : hideWindow()
})

watch(() => catStore.window.passThrough, (value) => {
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

watch(() => catStore.model.motionSound, live2d.setMotionSoundEnabled, { immediate: true })

watch(() => catStore.model.maxFPS, live2d.setMaxFPS, { immediate: true })

useTauriListen<MotionInfo>(LISTEN_KEY.START_MOTION, ({ payload }) => {
  live2d.startMotion(payload)
})

useTauriListen<number>(LISTEN_KEY.SET_EXPRESSION, ({ payload }) => {
  live2d.setExpression(payload)
})

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, button, select, form, [contenteditable="true"]'))
}

function handleMouseDown(event: MouseEvent) {
  if (isInteractiveTarget(event.target)) return

  appWindow.startDragging()
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.shiftKey) return

  const menu = await Menu.new({
    items: [
      ...await getBaseMenu(),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...await getExitMenu(),
    ],
  })

  // Temporarily disable always-on-top on Windows so the context menu is not covered
  if (isWindows && catStore.window.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  await menu.popup()

  // Restore always-on-top after the menu is closed
  if (!isWindows || !catStore.window.alwaysOnTop) return

  setAlwaysOnTop(true)
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, shiftKey, movementX, movementY } = event

  if (buttons !== 2 || !shiftKey) return

  const delta = (movementX + movementY) * 0.5
  const nextScale = Math.max(10, Math.min(catStore.window.scale + delta, 500))

  catStore.window.scale = round(nextScale)
}

function clearDialogueTimers() {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer)
    heartbeatTimer = void 0
  }

  if (dialogueShowFrame) {
    cancelAnimationFrame(dialogueShowFrame)
    dialogueShowFrame = void 0
  }

  if (dialogueHideTimer) {
    clearTimeout(dialogueHideTimer)
    dialogueHideTimer = void 0
  }
}

function scheduleNextHeartbeat() {
  if (chatLoading.value) return

  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer)
  }

  const delay = Math.max(10, heartbeat.intervalSeconds) * 1_000

  heartbeatTimer = setTimeout(runHeartbeat, delay)
}

function showDialogue(text: string, duration = 5_000, shouldScheduleNext = true) {
  if (dialogueHideTimer) {
    clearTimeout(dialogueHideTimer)
    dialogueHideTimer = void 0
  }

  if (dialogueShowFrame) {
    cancelAnimationFrame(dialogueShowFrame)
    dialogueShowFrame = void 0
  }

  const show = () => {
    dialogueShowFrame = void 0
    dialogueText.value = text
    dialogueVisible.value = true

    if (duration <= 0) return

    dialogueHideTimer = setTimeout(() => {
      hideDialogue()

      if (shouldScheduleNext) {
        scheduleNextHeartbeat()
      }
    }, duration)
  }

  if (!dialogueVisible.value) {
    show()
    return
  }

  dialogueVisible.value = false
  dialogueShowFrame = requestAnimationFrame(() => {
    dialogueShowFrame = requestAnimationFrame(show)
  })
}

function hideDialogue() {
  dialogueVisible.value = false
  dialogueHideTimer = void 0

  requestAnimationFrame(() => {
    if (dialogueVisible.value) return

    dialogueText.value = ''
  })
}

async function runHeartbeat() {
  heartbeatTimer = void 0

  if (chatLoading.value || dialogueVisible.value) {
    scheduleNextHeartbeat()
    return
  }

  const activitySummary = consumePetActivitySummary()

  try {
    const {
      reply,
      memory_updates: memoryUpdates,
      task_updates: taskUpdates,
    } = await generatePetHeartbeat(activitySummary)

    await Promise.all([
      applyPetMemoryUpdates(memoryUpdates).catch(() => {}),
      applyPetTaskUpdates(taskUpdates).catch(() => {}),
    ])

    showDialogue(reply || '我在这里陪着你。', heartbeat.replyDurationMs)
    return
  } catch {
    showDialogue('我刚刚有点走神，但还在陪你。', heartbeat.replyDurationMs)
    return
  }

  scheduleNextHeartbeat()
}

async function handleChatSubmit() {
  const text = chatInput.value.trim()

  if (!text || chatLoading.value) return

  clearDialogueTimers()

  chatInput.value = ''
  chatLoading.value = true

  const nextHistory: LLMMessage[] = [
    ...chatHistory.value,
    { role: 'user', text },
  ].slice(-8)

  chatHistory.value = nextHistory
  hideDialogue()

  try {
    const {
      reply,
      memory_updates: memoryUpdates,
      task_updates: taskUpdates,
    } = await generatePetReply(nextHistory)

    chatHistory.value = [
      ...nextHistory,
      { role: 'model', text: reply },
    ].slice(-8)

    showDialogue(reply, 12_000)

    await Promise.all([
      applyPetMemoryUpdates(memoryUpdates).catch(() => {}),
      applyPetTaskUpdates(taskUpdates).catch(() => {}),
    ])
  } catch (error) {
    showDialogue(error instanceof Error ? error.message : '我刚刚没听清，再说一次？', 7_000)
  } finally {
    chatLoading.value = false
  }
}
</script>

<template>
  <div
    class="relative size-screen overflow-hidden"
    :style="{
      borderRadius: `${catStore.window.radius}%`,
    }"
    @contextmenu="handleContextmenu"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
  >
    <div
      class="dialogue-bubble-panel"
      :class="{ 'is-visible': dialogueVisible }"
      @mousedown.stop
      @mousemove.stop
    >
      <span class="break-words leading-snug">
        {{ dialogueText }}
      </span>
    </div>

    <div
      class="absolute bottom-0 left-0 w-full children:(absolute size-full)"
      :class="{ '-scale-x-100': catStore.model.mirror }"
      :style="{
        height: modelLayerHeight,
        bottom: chatLayerHeight,
        opacity: catStore.window.opacity / 100,
      }"
    >
      <img
        v-if="backgroundImagePath"
        class="object-cover"
        :src="backgroundImagePath"
      >

      <canvas id="live2dCanvas" />

      <img
        v-for="path in modelStore.pressedKeys"
        :key="path"
        class="object-cover"
        :src="convertFileSrc(path)"
      >
    </div>

    <form
      class="chat-input-panel"
      :style="{ height: chatLayerHeight }"
      @click.stop
      @contextmenu.stop
      @mousedown.stop
      @mousemove.stop
      @mouseup.stop
      @pointerdown.stop
      @pointerup.stop
      @submit.prevent="handleChatSubmit"
    >
      <input
        v-model="chatInput"
        class="chat-input"
        :disabled="chatLoading"
        placeholder="和猫猫说点什么..."
        @click.stop
        @mousedown.stop
        @pointerdown.stop
      >

      <button
        class="chat-submit"
        :disabled="chatLoading || !chatInput.trim()"
        type="submit"
      >
        {{ chatLoading ? '等待' : '发送' }}
      </button>
    </form>

    <div
      v-show="resizing || !modelStore.modelReady"
      class="absolute left-0 top-0 size-full flex items-center justify-center bg-black"
    >
      <span class="text-center text-[10vw] text-[#fff]">
        {{ resizing ? $t('pages.main.hints.redrawing') : $t('pages.main.hints.switching') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.dialogue-bubble-panel {
  position: absolute;
  z-index: 10;
  top: 8px;
  right: 0;
  left: 0;
  width: min(320px, calc(100% - 24px));
  height: 68px;
  margin: 0 auto;
  padding: 8px 12px;
  color: #000;
  font-size: clamp(13px, 4vw, 18px);
  line-height: 1.35;
  text-align: center;
  word-break: break-word;
  overflow-wrap: anywhere;
  overflow: hidden;
  pointer-events: none;
  background: #fff;
  border: 1px solid rgb(0 0 0 / 18%);
  border-radius: 8px;
  opacity: 0;
  visibility: hidden;
  contain: paint;
  isolation: isolate;
}

.dialogue-bubble-panel.is-visible {
  opacity: 1;
  visibility: visible;
}

.dialogue-bubble-panel::after {
  position: absolute;
  left: 50%;
  top: 100%;
  width: 12px;
  height: 12px;
  content: '';
  background: #fff;
  border-right: 1px solid rgb(0 0 0 / 18%);
  border-bottom: 1px solid rgb(0 0 0 / 18%);
  transform: translate(-50%, -50%) rotate(45deg);
}

.dialogue-bubble-panel:not(.is-visible)::after {
  display: none;
}

.chat-input-panel {
  position: absolute;
  z-index: 20;
  bottom: 0;
  left: 0;
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  min-height: 42px;
  padding: 6px 8px 8px;
  pointer-events: auto;
}

.chat-input {
  min-width: 0;
  height: 30px;
  flex: 1;
  padding: 0 10px;
  color: #111;
  font-size: 13px;
  background: #fff;
  border: 1px solid rgb(0 0 0 / 20%);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 16%);
  outline: none;
}

.chat-input:focus {
  border-color: rgb(0 0 0 / 42%);
}

.chat-submit {
  width: 52px;
  height: 30px;
  flex: none;
  color: #fff;
  font-size: 13px;
  background: #111;
  border: 0;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 18%);
  cursor: pointer;
}

.chat-submit:disabled,
.chat-input:disabled {
  cursor: default;
  opacity: 0.62;
}
</style>

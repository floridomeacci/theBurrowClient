import { BTN } from "@burrow/sim";

/** Keyboard + mouse state → input frames. */
export class InputState {
  keys = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  mouseDown = false;
  slot = 1;
  showMap = false;
  availableSlots = [1, 2];
  private keyboardFacing: number | null = null;
  private primaryPulseFrames = 0;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code.startsWith("Digit") || e.code.startsWith("Numpad")) {
        const prefixLength = e.code.startsWith("Digit") ? 5 : 6;
        const page = Number(e.code.slice(prefixLength));
        const slot = this.availableSlots[page - 1];
        if (slot !== undefined) this.slot = slot;
      }
      if (e.code === "Tab") {
        e.preventDefault();
        this.showMap = true;
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
      this.keys.delete(e.code);
      if (e.code === "Tab") this.showMap = false;
    });
    window.addEventListener("blur", () => this.keys.clear());
    canvas.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseDown = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.cycle(e.deltaY >= 0 ? 1 : -1);
    }, { passive: false });
  }

  setAvailableSlots(slots: number[]): void {
    const next = slots.length > 0 ? slots : [1];
    const oldIndex = Math.max(0, this.availableSlots.indexOf(this.slot));
    this.availableSlots = next;
    if (!next.includes(this.slot)) this.slot = next[Math.min(oldIndex, next.length - 1)];
  }

  cycle(direction: -1 | 1): number {
    const current = Math.max(0, this.availableSlots.indexOf(this.slot));
    this.slot = this.availableSlots[(current + direction + this.availableSlots.length) % this.availableSlots.length];
    return this.slot;
  }

  pulsePrimary(): void {
    this.primaryPulseFrames = Math.max(this.primaryPulseFrames, 2);
  }

  moveX(): number {
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight");
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  moveY(): number {
    const down = this.keys.has("KeyS") || this.keys.has("ArrowDown");
    const up = this.keys.has("KeyW") || this.keys.has("ArrowUp");
    return (down ? 1 : 0) - (up ? 1 : 0);
  }

  buttons(): number {
    let b = 0;
    if (this.mouseDown || this.keys.has("Space") || this.primaryPulseFrames > 0) b |= BTN.PRIMARY;
    if (this.primaryPulseFrames > 0) this.primaryPulseFrames--;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) b |= BTN.SPRINT;
    if (this.keys.has("KeyE")) b |= BTN.INTERACT;
    if (this.keys.has("KeyQ")) b |= BTN.USE;
    if (this.keys.has("KeyR")) b |= BTN.PLACE;
    if (this.keys.has("KeyF")) b |= BTN.TRIGGER;
    if (this.keys.has("KeyV")) b |= BTN.HUNT;
    return b;
  }

  /** Aim angle quantized to 0..255, given player screen position. */
  aim(playerScreenX: number, playerScreenY: number): number {
    const moveX = this.moveX();
    const moveY = this.moveY();
    if (moveX !== 0 || moveY !== 0) this.keyboardFacing = this.quantizeAim(Math.atan2(moveY, moveX));
    if (this.keys.has("Space") && this.keyboardFacing !== null) return this.keyboardFacing;
    return this.quantizeAim(Math.atan2(this.mouseY - playerScreenY, this.mouseX - playerScreenX));
  }

  private quantizeAim(angle: number): number {
    return Math.round((((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 256) & 255;
  }
}

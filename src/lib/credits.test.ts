import { describe, expect, test } from "bun:test"
import { DT_PER_USD, WELCOME_CREDITS_DT, WELCOME_DISPLAY_USD } from "./credits"

describe("welcome credits", () => {
  test("grants one dollar of credits", () => {
    expect(WELCOME_CREDITS_DT).toBe(DT_PER_USD * 0.5)
    expect(WELCOME_DISPLAY_USD).toBe(0.5)
  })
})

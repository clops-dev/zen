import bcrypt from "bcryptjs"
import { env } from "./env"

export const hashPassword = (password: string) => bcrypt.hash(password, env.BCRYPT_COST)
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash)

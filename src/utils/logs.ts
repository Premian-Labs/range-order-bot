import { logLevel } from '../config/config'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'

export class LogManager {
	private static readonly LogLevel = {
		APP: { value: 0, emoji: '💎', color: '\x1b[36m' /* cyan */ },
		DEBUG: { value: 1, emoji: '🐛', color: '\x1b[90m' /* grey */ },
		INFO: { value: 2, emoji: 'ℹ️', color: '\x1b[32m' /* green */ },
		WARNING: { value: 3, emoji: '⚠️', color: '\x1b[33m' /* yellow */ },
		ERROR: { value: 4, emoji: '❌', color: '\x1b[31m' /* red */ },
	}

	private currentLogLevel: number

	//log level set via config file
	constructor(_logLevel: LogLevel = logLevel) {
		this.currentLogLevel = LogManager.LogLevel[_logLevel].value
	}

	public setLogLevel(level: LogLevel): void {
		this.currentLogLevel = LogManager.LogLevel[level].value
	}

	public app(...message: any[]): void {
		console.log(
			LogManager.LogLevel.APP.color,
			` ${LogManager.LogLevel.APP.emoji} [APP]: `,
			...message,
		)
	}

	public debug(...message: any[]): void {
		if (this.currentLogLevel <= LogManager.LogLevel.DEBUG.value) {
			console.log(
				LogManager.LogLevel.DEBUG.color,
				` ${LogManager.LogLevel.DEBUG.emoji} [DEBUG]: `,
				...message,
			)
		}
	}

	public info(...message: any[]): void {
		if (this.currentLogLevel <= LogManager.LogLevel.INFO.value) {
			console.log(
				LogManager.LogLevel.INFO.color,
				` ${LogManager.LogLevel.INFO.emoji} [INFO]: `,
				...message,
			)
		}
	}

	public warning(...message: any[]): void {
		if (this.currentLogLevel <= LogManager.LogLevel.WARNING.value) {
			console.log(
				LogManager.LogLevel.WARNING.color,
				` ${LogManager.LogLevel.WARNING.emoji} [WARNING]: `,
				...message,
			)
		}
	}

	public error(...message: any[]): void {
		if (this.currentLogLevel <= LogManager.LogLevel.ERROR.value) {
			console.error(
				LogManager.LogLevel.ERROR.color,
				` ${LogManager.LogLevel.ERROR.emoji} [ERROR]: `,
				...message,
			)
		}
	}
}

export const log = new LogManager()

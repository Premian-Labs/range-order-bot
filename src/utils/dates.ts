import moment from 'moment'
import { SECONDS_IN_YEAR } from '../constants'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

export const FRIDAY = 5

export function getCurrentTimestamp(): number {
	return moment.utc().unix()
}

export function getTTM(maturityTimestamp: number): number {
	const ts = moment.utc().unix()
	return (maturityTimestamp - ts) / SECONDS_IN_YEAR
}

export function getDaysToExpiration(maturity: string): number {
	const expirationMoment = moment.utc(maturity, 'DDMMMYY')

	// 1. check if option expiration is a valid date
	if (!expirationMoment.isValid()) {
		throw new Error(`Invalid expiration date: ${maturity}`)
	}

	const today = moment.utc().startOf('day')
	// NOTE: this returns a floor integer value for day (ie 1.9 days -> 1)
	return expirationMoment.diff(today, 'days')
}

export function createExpiration(maturity: string): number {
	const expirationMoment = moment.utc(maturity, 'DDMMMYY')

	// 1. check if option expiration is a valid date
	if (!expirationMoment.isValid()) {
		throw new Error(`Invalid expiration date: ${maturity}`)
	}

	// NOTE: this returns a floor integer value for day (ie 1.9 days -> 1)
	const daysToExpiration = getDaysToExpiration(maturity)

	// 2. DAILY and PAST OPTIONS: if option expiration is in the past, tomorrow, or the day after tomorrow, return as valid
	if (daysToExpiration <= 2) {
		// Set time to 8:00 AM
		return expirationMoment.add(8, 'hours').unix()
	}

	// 3. WEEKLY OPTIONS: check if option expiration is Friday
	if (expirationMoment.day() !== 5) {
		throw new Error(`${expirationMoment.toJSON()} is not Friday!`)
	}

	// 4. MONTHLY OPTIONS: if option maturity > 30 days, validate expire is last Friday of the month
	if (daysToExpiration > 30) {
		const lastDay = expirationMoment.clone().endOf('month').startOf('day')
		lastDay.subtract((lastDay.day() + 2) % 7, 'days')

		if (!lastDay.isSame(expirationMoment)) {
			throw new Error(
				`${expirationMoment.toJSON()} is not the last Friday of the month!`,
			)
		}
	}

	// Set time to 8:00 AM
	return expirationMoment.add(8, 'hours').unix()
}

//TODO:  do we need this? (no usage)
export function nextYearOfMaturities(): dayjs.Dayjs[] {
	const maturities: dayjs.Dayjs[] = []
	const now = dayjs().utc()

	// Dailies
	let today = now.clone().startOf('day').hour(8)
	let tomorrow = today.clone().add(1, 'day')
	let twoDays = today.clone().add(2, 'day')

	// Weeklies
	let friday = now.clone().startOf('day').hour(8).day(FRIDAY)
	if (now.day() >= FRIDAY) {
		friday = friday.add(1, 'week')
	}
	const secondFriday = friday.clone().add(1, 'week')
	const thirdFriday = friday.clone().add(2, 'week')
	const fourthFriday = friday.clone().add(3, 'week')
	const fifthFriday = friday.clone().add(4, 'week')

	// Monthlies
	const currentMonth = now.month()
	const months = []
	for (let i = 1; i <= 12; ++i) {
		let monthly = now
			.clone()
			.month(currentMonth + i)
			.startOf('month')
			.hour(8)
			.day(FRIDAY)
		if (monthly.date() > 7) {
			monthly = monthly.subtract(1, 'week')
		}
		while (monthly.month() === currentMonth + i) {
			monthly = monthly.add(1, 'week')
		}
		monthly = monthly.subtract(1, 'week')
		months.push(monthly)
	}

	// Check and push to maturities
	if (today.isAfter(now)) {
		maturities.push(today)
	}
	if (tomorrow.isAfter(now)) {
		maturities.push(tomorrow)
	}
	maturities.push(twoDays)

	const fridays = [friday, secondFriday, thirdFriday, fourthFriday, fifthFriday]
	fridays.forEach((fri: dayjs.Dayjs) => {
		if (!maturities.find((maturity) => maturity.isSame(fri))) {
			maturities.push(fri)
		}
	})

	for (let monthly of months) {
		if (!maturities.find((maturity) => maturity.isSame(monthly))) {
			maturities.push(monthly)
		}
	}

	return maturities
}

export function getLast30Days(): moment.Moment[] {
	const days: moment.Moment[] = []
	const today = moment().startOf('day') // Start from the beginning of today

	for (let i = 0; i < 30; i++) {
		// Subtract 'i' days from today and add to the list
		days.push(today.clone().subtract(i, 'days'))
	}

	return days
}

export async function delay(t: number) {
	return new Promise((resolve) => setTimeout(resolve, t))
}

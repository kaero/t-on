read:
	minipro -p GD25Q64C -r dump.bin

write: dump.bin
	minipro -p GD25Q64C -P -w dump.bin


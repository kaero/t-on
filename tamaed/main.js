"use strict";
(function () {
    class EventEmitter {
        constructor() {
            this.events = new Map();
        }

        on(event, listener) {
            const listeners = this.events.get(event) || [];
            this.events.set(event, [listener].concat(listeners));
        }

        emit(event, ...args) {
            const listeners = this.events.get(event) || [];
            for (const listener of listeners) {
                listener(...args);
            }
        }
    }

    function fixDPI(canvas) {
        const dpi = window.devicePixelRatio;
        const cs = getComputedStyle(canvas);
        const width = cs.getPropertyValue("width").slice(0, -2);
        const height = cs.getPropertyValue("height").slice(0, -2);
        canvas.setAttribute("width", width * dpi);
        canvas.setAttribute("height", height * dpi);
    }

    class Application extends EventEmitter {
        constructor(scan = () => null) {
            super();
            this.firmware = null;
            this.map = null;
            this.scan = scan;
        }

        static events = {
            firmwareReady: "firmwareReady",
            mapReady: "mapReady",
        };

        async changeFirmware(file) {
            this.firmware = new Uint8Array(await file.arrayBuffer());
            this.map = null;
            this.emit(Application.events.firmwareReady);
        }

        async buildMap() {
            if (this.firmware === null) {
                return;
            }
            const map = [];
            const bytes = this.firmware;
            const scan = this.scan;
            for (let idx = 0; idx < bytes.length; idx++) {
                const item = scan(bytes, idx);
                if (item !== null) {
                    map.push(item);
                    idx += item.size - 1;
                }
            }
            this.map = map;
            this.emit(Application.events.mapReady);
        }
    }

    class TODataItem {
        constructor(offset, bytes, type = "unknown") {
            this.type = type;
            this.offset = offset;
            this.size = bytes.length;
            this.bytes = bytes;
        }
    }

    class TOImage extends TODataItem {
        static typeName = "image";

        static headerSize = 5;

        constructor(offset, bytes) {
            super(offset, bytes, TOImage.typeName);
            // unused? header bytes
            this.byte_5 = bytes[3];
            this.byte_6 = bytes[4];
            this.byte_7 = bytes[5];

            this.width = bytes[0];
            this.height = bytes[1];
            this.colorsCount = bytes[2];

            const paletteSize = this.colorsCount * 2;
            this.paletteData = bytes.subarray(TOImage.headerSize + 1, TOImage.headerSize + paletteSize + 1);
            this.palette = null;

            this.imageData = bytes.subarray(TOImage.headerSize + paletteSize + 1);
            this.image = null;
        }

        getPalette() {
            if (this.palette === null) {
                this.palette = TOImage.decodePalette(this.paletteData);
            }
            return this.palette;
        }

        getImage() {
            if (this.image === null) {
                this.image = TOImage.decodeImage(this.imageData, this.getPalette());
            }
            return this.image;
        }

        static decodePalette(bytes) {
            const palette = [];
            // each color encoded by 16 bit big-endian word in order: 5 blue, 6 green, 5 red
            // a palette decoding was spied on the @ianling fork
            // https://github.com/ianling/t-on/blob/42a01b3d80fb89c8a4227d0dc7d33225a7d6505b/extract.py#L90-L104
            // which was inspired (as noted) by MyMeets https://tamatown.com/downloads
            for (let i = 0; i < bytes.length; i += 2) {
                const hi = bytes[i];
                const lo = bytes[i + 1];
                const color16 = (hi << 8) ^ lo;
                const blue = Math.round((((color16 & 0xf800) >> 11) / 31) * 255);
                const green = Math.round((((color16 & 0x7e0) >> 5) / 63) * 255);
                const red = Math.round(((color16 & 0x1f) / 31) * 255);
                palette.push([red, green, blue, 255]);
            }
            return palette;
        }

        static decodeImage(bytes, palette) {
            const halfBytePixel = palette.length <= 16;
            const pixelsCount = halfBytePixel ? bytes.length * 2 : bytes;
            const pixels = new Uint8ClampedArray(pixelsCount * 4);
            if (halfBytePixel) {
                for (let i = 0; i < bytes.length; i++) {
                    const byte = bytes[i];
                    const idx = i * 2;
                    pixels.set(palette[byte & 0xf], idx * 4);
                    pixels.set(palette[byte >> 4], idx * 4 + 4);
                }
            } else {
                for (let i = 0; i < bytes.length; i++) {
                    pixels.set(palette[bytes[i]], i * 4);
                }
            }
            return pixels;
        }

        static scanForImage(bytes, offset) {
            const width = bytes[offset + 0];
            const height = bytes[offset + 1];
            const paletteSize = bytes[offset + 2];

            if (
                bytes.length - offset > 10 &&
                width > 0 &&
                width <= 128 &&
                height > 0 &&
                height <= 128 &&
                paletteSize > 0 &&
                bytes[offset + 3] === 0 /*   magic? */ &&
                bytes[offset + 4] === 1 /*   magic? */ &&
                bytes[offset + 5] === 255 /* magic? */
            ) {
                const headerSize = 6 + paletteSize * 2;
                const pixelPerByte = paletteSize > 16 ? 1 : 2;
                // less than 16 colors per pixel encoded using 4 bits, so 2 pixels encoded by 1 byte
                const size = headerSize + Math.ceil((width * height) / pixelPerByte);
                try {
                    return new TOImage(offset, bytes.subarray(offset, offset + size));
                } catch (e) {
                    console.error(`Failed to build image at offset ${offset}`);
                    console.error(bytes.subarray(offset, offset + size));
                    return null;
                }
            } else {
                return null;
            }
        }

        drawTo(canvas, scale = 1) {
            const xScale = scale;
            const yScale = scale;

            const width = this.width * xScale;
            const height = this.height * yScale;

            const widthPixelBytes = width * 4;
            const xOffsetPixelBytes = xScale * 4;
            const rowOffsetBytes = yScale * widthPixelBytes;

            canvas.width = width;
            canvas.height = height;
            fixDPI(canvas);

            const ctx = canvas.getContext("2d");
            const img = ctx.createImageData(width, height);
            const src = this.getImage();
            for (let y = 0; y < this.height; y++) {
                const srcRowOffset = y * this.width * 4;
                const rowOffset = y * rowOffsetBytes;

                for (let x = 0; x < this.width; x++) {
                    const srcPixelOffset = srcRowOffset + x * 4;
                    const pixelOffset = rowOffset + x * xOffsetPixelBytes;

                    for (let xs = 0; xs < xScale; xs++) {
                        img.data.set(src.slice(srcPixelOffset, srcPixelOffset + 4), pixelOffset + xs * 4);
                    }
                }

                const row = img.data.slice(rowOffset, rowOffset + widthPixelBytes);
                for (let ys = 1; ys < yScale; ys++) {
                    img.data.set(row, rowOffset + ys * widthPixelBytes);
                }
            }
            ctx.putImageData(img, 0, 0);
        }
    }

    function $(selector) {
        return document.querySelector(selector);
    }

    function passFirstFileTo(fn) {
        return function (event) {
            const files = event.target.files;
            if (files.length > 0) {
                return fn(files[0]);
            }
        };
    }

    const selectionMapColor = new Uint8ClampedArray([255, 55, 55, 255]);
    const defaultMapColor = new Uint8ClampedArray([100, 100, 100, 255]);
    const dataTypeColors = new Map([[TOImage.typeName, new Uint8ClampedArray([255, 255, 0, 255])]]);

    /** @return {Uint8ClampedArray} */
    function colorByDataType(type) {
        const typeColor = dataTypeColors.get(type);
        return typeColor !== undefined ? typeColor : defaultMapColor;
    }

    const chunkSize = 2048;
    const bytesPerPixel = 8;

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Map<number, TODataItem>} map
     * @param {Number} dataSize
     * @param {Number} selectionStart
     * @param {Number} selectionEnd
     */
    function drawMapTo(canvas, map, dataSize, selectionStart, selectionEnd) {
        if (chunkSize % bytesPerPixel > 0) {
            throw new Error("Can not draw map to canvas: chunk size must be a multiple of bytesPerPixel");
        }

        const height = chunkSize / bytesPerPixel;
        const width = Math.ceil(dataSize / chunkSize);
        canvas.height = height;
        canvas.width = width;
        fixDPI(canvas);

        const ctx = canvas.getContext("2d");
        if (map === null) {
            return;
        }

        const img = ctx.createImageData(width, height);
        const iter = map[Symbol.iterator]();
        const { done, value } = iter.next();
        const selectionStartYX = Math.floor(selectionStart / bytesPerPixel);
        const selectionEndYX = Math.floor(selectionEnd / bytesPerPixel);
        let colorStartYX = done ? Infinity : Math.floor(value.offset / bytesPerPixel);
        let colorEndYX = done ? Infinity : Math.floor((value.offset + value.size) / bytesPerPixel);
        let color = done ? defaultMapColor : colorByDataType(value.type);

        for (let x = 0; x < width; x++) {
            const yxColumnOffset = x * height;
            for (let y = 0; y < height; y++) {
                const yxIndex = yxColumnOffset + y;
                const pixelOffset = (y * width + x) * 4;
                let drawColor = defaultMapColor;
                if (yxIndex >= colorStartYX) {
                    drawColor = color;
                    while (yxIndex === colorEndYX) {
                        const { done, value } = iter.next();
                        colorStartYX = done ? Infinity : Math.floor(value.offset / bytesPerPixel);
                        colorEndYX = done ? Infinity : Math.floor((value.offset + value.size) / bytesPerPixel);
                        color = done ? defaultMapColor : colorByDataType(value.type);
                    }
                }
                if (yxIndex >= selectionStartYX && yxIndex < selectionEndYX) {
                    drawColor = selectionMapColor;
                }
                img.data.set(drawColor, pixelOffset);
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    function createElement(tagName, classAttrValue, text = null) {
        const element = document.createElement(tagName);
        element.setAttribute("class", classAttrValue);

        if (text !== null) {
            const textNode = document.createTextNode(text);
            element.appendChild(textNode);
        }

        return element;
    }

    function nearestDataOffsetAttributeValue(target) {
        while (target.getAttribute("data-id") === null && target.tagName !== "ul") {
            target = target.parentElement;
        }
        return parseInt(target.getAttribute("data-id"), 10);
    }

    const hexViewRowSize = 16;

    async function init() {
        const app = new Application(TOImage.scanForImage);
        window.toapp = app;
        let previewItem = null;

        const mapCanvas = $("#map-canvas");
        const entitiesList = $("#entities-list");
        const entityPreviewScaleInput = $("#entity-preview-scale-input");
        const entityPreviewCanvas = $("#entity-preview-canvas");
        const hexPageSizeInput = $("#hex-page-size-input");
        const hexOffsetInput = $("#hex-offset-input");
        const hexPageUpButton = $("#hex-page-up-button");
        const hexRowUpButton = $("#hex-row-up-button");
        const hexRowDownButton = $("#hex-row-down-button");
        const hexPageDownButton = $("#hex-page-down-button");
        const hexControls = [
            hexPageSizeInput,
            hexOffsetInput,
            hexPageUpButton,
            hexRowUpButton,
            hexRowDownButton,
            hexPageDownButton,
        ];
        const hexAreaOffsets = $("#hex-area-offsets");
        const hexAreaHextets = $("#hex-area-hextets");
        const hexAreaChars = $("#hex-area-chars");

        $("#firmware-file-input").addEventListener(
            "change",
            passFirstFileTo((file) => app.changeFirmware(file))
        );

        function getEntityPreviewScale() {
            return parseInt(entityPreviewScaleInput.value, 10) || 1;
        }

        /** @param {TODataItem|TOImage} dataItem */
        function setPreview(dataItem) {
            previewItem = dataItem;
            switch (dataItem.type) {
                case TOImage.typeName: {
                    dataItem.drawTo(entityPreviewCanvas, getEntityPreviewScale());
                    break;
                }
            }
        }

        entityPreviewScaleInput.addEventListener("change", () => {
            if (previewItem !== null) {
                setPreview(previewItem);
            }
        });

        function getHexViewOffset() {
            return hexOffsetInput.valueAsNumber;
        }

        function getHexViewPageSize() {
            const pageSize = hexPageSizeInput.valueAsNumber;
            return Math.ceil(pageSize / hexViewRowSize) * hexViewRowSize;
        }

        /** @param {Number} rawOffset */
        function navigateHexViewTo(rawOffset) {
            const pageSize = getHexViewPageSize();
            const maxOffset = app.firmware.length - pageSize;
            const offset = Math.min(maxOffset, Math.max(0, rawOffset));
            const bytes = Array.from(app.firmware.slice(offset, offset + pageSize));

            hexOffsetInput.value = offset;

            hexAreaOffsets.innerText = new Array(pageSize / hexViewRowSize)
                .fill("")
                .map((_, idx) => (offset + hexViewRowSize * idx).toString())
                .join("\n");
            hexAreaHextets.innerText = new Array(pageSize / hexViewRowSize)
                .fill("")
                .map((_, idx) =>
                    bytes
                        .slice(idx * hexViewRowSize, (idx + 1) * hexViewRowSize)
                        .map((byte) => (byte < 16 ? "0" + byte.toString(16) : byte.toString(16)))
                        .join(" ")
                )
                .join("\n");
            hexAreaChars.innerText = new Array(pageSize / hexViewRowSize)
                .fill("")
                .map((_, idx) =>
                    bytes
                        .slice(idx * hexViewRowSize, (idx + 1) * hexViewRowSize)
                        .map((byte) => (byte > 31 && byte < 127 ? String.fromCharCode(byte) : "."))
                        .join("")
                )
                .join("\n");

            drawMapTo(mapCanvas, app.map, app.firmware.byteLength, offset, offset + pageSize);
        }

        hexPageUpButton.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() - getHexViewPageSize()));
        hexRowUpButton.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() - hexViewRowSize));
        hexRowDownButton.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() + hexViewRowSize));
        hexPageDownButton.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() + getHexViewPageSize()));
        hexOffsetInput.addEventListener("change", () => navigateHexViewTo(getHexViewOffset()));
        hexPageSizeInput.addEventListener("change", () => navigateHexViewTo(getHexViewOffset()));

        entitiesList.addEventListener("click", (event) => {
            const idx = nearestDataOffsetAttributeValue(event.target);
            const dataItem = app.map[idx];
            navigateHexViewTo(dataItem.offset);
            setPreview(dataItem);
        });

        app.on(Application.events.firmwareReady, () => {
            entitiesList.textContent = "";
            app.buildMap();
        });

        app.on(Application.events.mapReady, () => {
            navigateHexViewTo(0);

            const fragment = document.createDocumentFragment();
            const map = app.map;
            for (let idx = 0; idx < map.length; idx++) {
                const dataItem = map[idx];
                const listItem = createElement("li", "entity");
                listItem.setAttribute("data-id", idx);

                listItem.appendChild(createElement("span", "entity-type", dataItem.type));
                listItem.appendChild(createElement("span", "entity-offset", dataItem.offset.toString()));
                listItem.appendChild(createElement("span", "entity-size", dataItem.size.toString()));

                switch (dataItem.type) {
                    case TOImage.typeName: {
                        const dimensionsItem = createElement("span", "entity-dimensions");
                        dimensionsItem.appendChild(
                            createElement("span", "entity-dimensions-width", dataItem.width.toString())
                        );
                        dimensionsItem.appendChild(
                            createElement("span", "entity-dimensions-height", dataItem.height.toString())
                        );
                        listItem.appendChild(dimensionsItem);

                        listItem.appendChild(createElement("span", "entity-colors", dataItem.colorsCount.toString()));
                        break;
                    }
                }

                fragment.appendChild(listItem);
            }
            entitiesList.appendChild(fragment);

            hexControls.forEach((control) => control.removeAttribute("disabled"));
        });
    }

    window.addEventListener("load", init);
})();

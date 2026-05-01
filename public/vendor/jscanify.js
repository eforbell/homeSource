/*! jscanify v1.4.0-improved | Based on ColonelParrot/jscanify | MIT License */

(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined"
    ? (module.exports = factory())
    : typeof define === "function" && define.amd
      ? define(factory)
      : (global.jscanify = factory());
})(this, function () {
  "use strict";

  function distance(p1, p2) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
  }

  class jscanify {
    constructor() { }

    findPaperContour(img) {
      const gray = new cv.Mat();
      cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);

      const minArea = img.rows * img.cols * 0.05;

      let result = this._detectQuad(gray, 50, 150, minArea)
                || this._detectQuad(gray, 30, 80, minArea)
                || this._detectLargest(gray, 50, 150, minArea);

      gray.delete();
      return result;
    }

    _preprocess(gray, cannyLow, cannyHigh) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      const edges = new cv.Mat();
      cv.Canny(blurred, edges, cannyLow, cannyHigh);
      blurred.delete();

      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, kernel);
      cv.erode(edges, edges, kernel);
      kernel.delete();

      return edges;
    }

    _detectQuad(gray, cannyLow, cannyHigh, minArea) {
      const edges = this._preprocess(gray, cannyLow, cannyHigh);

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      edges.delete();

      let bestQuad = null;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < minArea || area <= bestArea) continue;

        const peri = cv.arcLength(contour, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, peri * 0.03, true);

        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          if (bestQuad) bestQuad.delete();
          bestQuad = approx.clone();
          bestArea = area;
        }
        approx.delete();
      }

      hierarchy.delete();
      contours.delete();
      return bestQuad;
    }

    _detectLargest(gray, cannyLow, cannyHigh, minArea) {
      const edges = this._preprocess(gray, cannyLow, cannyHigh);

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      edges.delete();

      let maxArea = 0;
      let maxIdx = -1;
      for (let i = 0; i < contours.size(); i++) {
        const area = cv.contourArea(contours.get(i));
        if (area > maxArea && area >= minArea) {
          maxArea = area;
          maxIdx = i;
        }
      }

      let result = null;
      if (maxIdx >= 0) {
        result = contours.get(maxIdx).clone();
      }

      hierarchy.delete();
      contours.delete();
      return result;
    }

    highlightPaper(image, options) {
      options = options || {};
      options.color = options.color || "orange";
      options.thickness = options.thickness || 10;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const img = cv.imread(image);

      const maxContour = this.findPaperContour(img);
      cv.imshow(canvas, img);
      if (maxContour) {
        const {
          topLeftCorner, topRightCorner,
          bottomLeftCorner, bottomRightCorner,
        } = this.getCornerPoints(maxContour);

        if (topLeftCorner && topRightCorner && bottomLeftCorner && bottomRightCorner) {
          ctx.strokeStyle = options.color;
          ctx.lineWidth = options.thickness;
          ctx.beginPath();
          ctx.moveTo(...Object.values(topLeftCorner));
          ctx.lineTo(...Object.values(topRightCorner));
          ctx.lineTo(...Object.values(bottomRightCorner));
          ctx.lineTo(...Object.values(bottomLeftCorner));
          ctx.lineTo(...Object.values(topLeftCorner));
          ctx.stroke();
        }
        maxContour.delete();
      }

      img.delete();
      return canvas;
    }

    extractPaper(image, resultWidth, resultHeight, cornerPoints) {
      const canvas = document.createElement("canvas");
      const img = cv.imread(image);
      const maxContour = cornerPoints ? null : this.findPaperContour(img);

      if (maxContour == null && cornerPoints === undefined) {
        img.delete();
        return null;
      }

      const {
        topLeftCorner, topRightCorner,
        bottomLeftCorner, bottomRightCorner,
      } = cornerPoints || this.getCornerPoints(maxContour);

      if (maxContour) maxContour.delete();

      let warpedDst = new cv.Mat();

      let dsize = new cv.Size(resultWidth, resultHeight);
      let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        topLeftCorner.x, topLeftCorner.y,
        topRightCorner.x, topRightCorner.y,
        bottomLeftCorner.x, bottomLeftCorner.y,
        bottomRightCorner.x, bottomRightCorner.y,
      ]);

      let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        resultWidth, 0,
        0, resultHeight,
        resultWidth, resultHeight,
      ]);

      let M = cv.getPerspectiveTransform(srcTri, dstTri);
      cv.warpPerspective(
        img, warpedDst, M, dsize,
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar()
      );

      cv.imshow(canvas, warpedDst);

      img.delete();
      warpedDst.delete();
      srcTri.delete();
      dstTri.delete();
      M.delete();
      return canvas;
    }

    getCornerPoints(contour) {
      const points = [];
      for (let i = 0; i < contour.data32S.length; i += 2) {
        points.push({ x: contour.data32S[i], y: contour.data32S[i + 1] });
      }

      if (points.length === 4) {
        points.sort((a, b) => a.y - b.y);
        const top = points.slice(0, 2).sort((a, b) => a.x - b.x);
        const bottom = points.slice(2, 4).sort((a, b) => a.x - b.x);
        return {
          topLeftCorner: top[0],
          topRightCorner: top[1],
          bottomLeftCorner: bottom[0],
          bottomRightCorner: bottom[1]
        };
      }

      let rect = cv.minAreaRect(contour);
      const center = rect.center;

      let topLeftCorner, topLeftCornerDist = 0;
      let topRightCorner, topRightCornerDist = 0;
      let bottomLeftCorner, bottomLeftCornerDist = 0;
      let bottomRightCorner, bottomRightCornerDist = 0;

      for (const point of points) {
        const dist = distance(point, center);
        if (point.x < center.x && point.y < center.y) {
          if (dist > topLeftCornerDist) { topLeftCorner = point; topLeftCornerDist = dist; }
        } else if (point.x > center.x && point.y < center.y) {
          if (dist > topRightCornerDist) { topRightCorner = point; topRightCornerDist = dist; }
        } else if (point.x < center.x && point.y > center.y) {
          if (dist > bottomLeftCornerDist) { bottomLeftCorner = point; bottomLeftCornerDist = dist; }
        } else if (point.x > center.x && point.y > center.y) {
          if (dist > bottomRightCornerDist) { bottomRightCorner = point; bottomRightCornerDist = dist; }
        }
      }

      return { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner };
    }
  }

  return jscanify;
});

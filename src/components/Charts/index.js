import React from "react";
import ReactFauxDOM from "react-faux-dom";
import * as d3 from "d3";
import "./index.css";

const INTERVAL_SIZE = 4; // hours

export class Streamgraph extends React.Component {
  parsedData() {
    let result = [];
    const { data } = this.props;
    data.forEach(layer => {
      const layerData = layer.reduce((acc, current) => {
        const parsed = new Date(current.x);
        const weekStart = d3.utcSunday(parsed);
        const hours = Math.round(
          Math.abs(
            (parsed.getTime() - weekStart.getTime()) / (3600000 * INTERVAL_SIZE)
          )
        );

        if (hours in acc) {
          acc[hours] = acc[hours] + 1;
        } else {
          acc[hours] = 1;
        }
        return acc;
      }, {});

      let layerResult = [];

      // Get y-start from previous
      // for stacking behavior
      let previous = [];
      if (result.length > 0) {
        previous = result[result.length - 1];
      }

      const maxX = 168 / INTERVAL_SIZE;

      for (let i = 0; i < maxX; i++) {
        let start = 0;
        if (previous) {
          const filtered = previous.filter(p => p.x === i);
          if (filtered.length > 0) {
            start = filtered[0].y.end;
          }
        }
        if (i in layerData) {
          layerResult.push({ x: i, y: { start, end: start + layerData[i] } });
        } else {
          layerResult.push({ x: i, y: { start, end: start } });
        }
      }

      result.push(layerResult);
    });

    return result;
  }

  render() {
    const div = new ReactFauxDOM.Element("div");

    let svg = d3
      .select(div)
      .classed("svg-container", true)
      .append("svg")
      .attr("preserveAspectRatio", "xMinYMin meet")
      .attr("viewBox", "0 0 600 200")
      .classed("svg-content-responsive", true);

    var colorrange = [
      "#d53e4f",
      "#f46d43",
      "#fdae61",
      "#fee08b",
      "#e6f598",
      "#abdda4",
      "#66c2a5",
      "#3288bd",
      "#5e4fa2"
    ];

    var width = 600;
    var height = 150;
    var margin = 20;
    var actualHeight = height - margin;
    var actualWidth = width - 2 * margin;

    const m = 168 / INTERVAL_SIZE; // hours

    var x = d3
      .scaleLinear()
      .domain([0, m])
      .range([margin, margin + actualWidth]);

    var y = d3
      .scaleLinear()
      .domain([0, 17]) // TODO: calculate this
      .range([actualHeight, 0]);

    var area = d3
      .area()
      .curve(d3.curveMonotoneX)
      .x(function(d) {
        return x(d.x);
      })
      .y0(function(d) {
        return y(d.y.start);
      })
      .y1(function(d) {
        return y(d.y.end);
      });

    svg
      .append("g")
      .selectAll("path")
      .data(this.parsedData())
      .enter()
      .append("path")
      .attr("d", area)
      .attr("fill", function(d, i) {
        return colorrange[i];
      })
      .on("mouseover", function(d, i) {
        console.log("mouse over", d, i);
      });

    var daysArea = d3
      .area()
      .x0(function(d, i) {
        return x(6 * d);
      })
      .x1(function(d, i) {
        return x(6 * (d + 1));
      })
      .y0(function(d, i) {
        return 0;
      })
      .y1(function(d, i) {
        return actualHeight;
      });

    var days = [[0], [1], [2], [3], [4], [5], [6]];
    svg
      .append("g")
      .selectAll("path")
      .data(days)
      .enter()
      .append("path")
      .attr("d", daysArea)
      .attr("class", function(d, i) {
        if (i % 2 === 0) return "day-background";
        else return "day-background-dark";
      });

    var axis = d3.axisBottom(x);
    svg
      .append("g")
      .attr("transform", `translate(0,${actualHeight})`)
      .call(axis);

    return div.toReact();
  }
}
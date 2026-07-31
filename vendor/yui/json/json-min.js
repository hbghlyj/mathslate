/* synthesized rollup for the standalone vendor copy: json = json-parse, json-stringify */
YUI.add("json-parse",function(e,t){var n=e.config.global.JSON;e.namespace("JSON").parse=function(e,t,r){return n.parse(typeof e=="string"?e:e+"",t,r)}},"3.18.1",{requires:["yui-base"]});

YUI.add("json-stringify",function(e,t){var n=":",r=e.config.global.JSON;e.mix(e.namespace("JSON"),{dateToString:function(e){function t(e){return e<10?"0"+e:e}return e.getUTCFullYear()+"-"+t(e.getUTCMonth()+1)+"-"+t(e.getUTCDate())+"T"+t(e.getUTCHours())+n+t(e.getUTCMinutes())+n+t(e.getUTCSeconds())+"Z"},stringify:function(){return r.stringify.apply(r,arguments)},charCacheThreshold:100})},"3.18.1",{requires:["yui-base"]});

